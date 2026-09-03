import type { DiscordGatewayAdapterCreator } from '@discordjs/voice';
import { logger as defaultLogger, type Logger } from './logger.js';
import type { MediaProvider, Track } from './media.js';
import { escapeMarkdown } from './presentation/discord-format.js';
import { idleDisconnectMessage } from './presentation/playback-responses.js';
import {
  DiscordPlaybackRuntime,
  type PlaybackController,
  type PlaybackPipeline,
  type PlaybackRuntime,
} from './playback-runtime.js';

const DEFAULT_MAX_QUEUE_LENGTH = 500;
const DEFAULT_EMPTY_DISCONNECT_MS = 5 * 60_000;

export type VoiceRequestContext = {
  guildId: string;
  voiceChannelId: string;
  adapterCreator: DiscordGatewayAdapterCreator;
  notify(message: string): Promise<unknown>;
};

export type QueueSnapshot = {
  current?: Track;
  upcoming: readonly Track[];
};

export type EnqueueResult = {
  snapshot: QueueSnapshot;
  started: boolean;
  position: number;
};

export type EnqueuePlacement = 'front' | 'back';

export type EnqueueOptions = {
  placement?: EnqueuePlacement;
};

export type SkipResult = {
  skipped: Track;
  startedNext: boolean;
  snapshot: QueueSnapshot;
};

export type StopResult = {
  stopped?: Track;
  removedUpcoming: number;
};

export type RemoveResult = {
  removed: readonly Track[];
  startPosition: number;
  endPosition: number;
  snapshot: QueueSnapshot;
};

export class PlaybackRequestError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PlaybackRequestError';
  }
}

type QueuedTrack = {
  track: Track;
  // Keep the request's text-channel callback with the track so later failures are
  // reported where that track was originally queued.
  notify(message: string): Promise<unknown>;
};

type GuildPlaybackSession = {
  controller: PlaybackController;
  voiceChannelId: string;
  notify(message: string): Promise<unknown>;
  current?: QueuedTrack;
  upcoming: QueuedTrack[];
  pipeline?: PlaybackPipeline;
  playbackAbort?: AbortController;
  disconnectTimer?: NodeJS.Timeout;
  emptyChannelTimer?: NodeJS.Timeout;
  // Runtime events carry this token so late Idle/Error events from an older track
  // cannot advance or clear the current one.
  generation: number;
  failedGeneration?: number;
};

export type PlaybackManagerOptions = {
  runtime?: PlaybackRuntime;
  maxQueueLength?: number;
  emptyDisconnectMs?: number;
  emptyChannelGraceMs?: number;
  logger?: Pick<Logger, 'error'>;
};

export class PlaybackManager {
  readonly #sessions = new Map<string, GuildPlaybackSession>();
  readonly #locks = new Map<string, Promise<void>>();
  readonly #runtime: PlaybackRuntime;
  readonly #maxQueueLength: number;
  readonly #emptyDisconnectMs: number;
  readonly #emptyChannelGraceMs: number;
  readonly #logger: Pick<Logger, 'error'>;

  constructor(
    private readonly provider: MediaProvider,
    options: PlaybackManagerOptions = {},
  ) {
    this.#runtime = options.runtime || new DiscordPlaybackRuntime();
    this.#maxQueueLength = options.maxQueueLength || DEFAULT_MAX_QUEUE_LENGTH;
    this.#emptyDisconnectMs =
      options.emptyDisconnectMs ?? DEFAULT_EMPTY_DISCONNECT_MS;
    this.#emptyChannelGraceMs = options.emptyChannelGraceMs ?? 30_000;
    this.#logger = options.logger || defaultLogger;
  }

  channelId(guildId: string): string | undefined {
    return this.#sessions.get(guildId)?.voiceChannelId;
  }

  snapshot(guildId: string): QueueSnapshot {
    const session = this.#sessions.get(guildId);
    return session ? snapshotOf(session) : { upcoming: [] };
  }

  enqueue(
    context: VoiceRequestContext,
    tracks: readonly Track[],
    options: EnqueueOptions = {},
  ): Promise<EnqueueResult> {
    return this.#serialize(context.guildId, async () => {
      if (tracks.length === 0) {
        throw new PlaybackRequestError('No playable tracks were provided.');
      }

      let session = this.#sessions.get(context.guildId);
      if (session && session.voiceChannelId !== context.voiceChannelId) {
        throw new PlaybackRequestError(
          'The bot is already active in a different voice channel.',
        );
      }

      const existingCount = session
        ? Number(Boolean(session.current)) + session.upcoming.length
        : 0;
      if (existingCount + tracks.length > this.#maxQueueLength) {
        throw new PlaybackRequestError(
          `The queue cannot contain more than ${this.#maxQueueLength} tracks.`,
        );
      }

      if (!session) {
        session = await this.#createSession(context);
        this.#sessions.set(context.guildId, session);
      }
      session.notify = context.notify;

      // Fresh work makes either kind of pending cleanup obsolete.
      if (session.disconnectTimer) clearTimeout(session.disconnectTimer);
      session.disconnectTimer = undefined;
      if (session.emptyChannelTimer) clearTimeout(session.emptyChannelTimer);
      session.emptyChannelTimer = undefined;

      const started = !session.current && session.upcoming.length === 0;
      const placement = options.placement ?? 'back';
      const firstPosition =
        placement === 'front' ? 1 : session.upcoming.length + 1;
      const queuedTracks = tracks.map((track) => ({
        track,
        notify: context.notify,
      }));
      if (placement === 'front') session.upcoming.unshift(...queuedTracks);
      else session.upcoming.push(...queuedTracks);
      await this.#startNext(context.guildId, session);
      if (started && !session.current) {
        throw new PlaybackRequestError(
          'Playback could not be started for that track.',
        );
      }

      return {
        snapshot: snapshotOf(session),
        started,
        position: firstPosition,
      };
    });
  }

  skip(guildId: string): Promise<SkipResult> {
    return this.#serialize(guildId, async () => {
      const session = this.#sessions.get(guildId);
      if (!session?.current) {
        throw new PlaybackRequestError('There is no active track to skip.');
      }

      const skipped = session.current.track;
      this.#disposePlayback(session);
      session.current = undefined;
      session.generation += 1;
      session.failedGeneration = undefined;
      session.controller.stop();

      await this.#startNext(guildId, session);
      return {
        skipped,
        startedNext: Boolean(session.current),
        snapshot: snapshotOf(session),
      };
    });
  }

  pause(guildId: string): Promise<QueueSnapshot> {
    return this.#serialize(guildId, async () => {
      const session = this.#requireCurrentSession(guildId, 'pause');
      if (session.controller.state() === 'paused') {
        throw new PlaybackRequestError('Playback is already paused.');
      }
      if (!session.controller.pause()) {
        throw new PlaybackRequestError(
          'The current track could not be paused.',
        );
      }
      return snapshotOf(session);
    });
  }

  resume(guildId: string): Promise<QueueSnapshot> {
    return this.#serialize(guildId, async () => {
      const session = this.#requireCurrentSession(guildId, 'resume');
      if (session.controller.state() === 'playing') {
        throw new PlaybackRequestError('Playback is already running.');
      }
      if (!session.controller.resume()) {
        throw new PlaybackRequestError(
          'The current track could not be resumed.',
        );
      }
      return snapshotOf(session);
    });
  }

  remove(
    guildId: string,
    startPosition: number,
    endPosition = startPosition,
  ): Promise<RemoveResult> {
    return this.#serialize(guildId, async () => {
      if (
        !Number.isSafeInteger(startPosition) ||
        !Number.isSafeInteger(endPosition) ||
        startPosition < 1 ||
        endPosition < startPosition
      ) {
        throw new PlaybackRequestError('The queue position range is invalid.');
      }

      const session = this.#sessions.get(guildId);
      if (!session || session.upcoming.length === 0) {
        throw new PlaybackRequestError(
          'There are no upcoming tracks to remove.',
        );
      }
      if (startPosition > session.upcoming.length) {
        throw new PlaybackRequestError(
          `The queue has only ${session.upcoming.length} upcoming track${session.upcoming.length === 1 ? '' : 's'}.`,
        );
      }

      const effectiveEndPosition = Math.min(
        endPosition,
        session.upcoming.length,
      );
      const removed = session.upcoming
        .splice(startPosition - 1, effectiveEndPosition - startPosition + 1)
        .map(({ track }) => track);
      return {
        removed,
        startPosition,
        endPosition: effectiveEndPosition,
        snapshot: snapshotOf(session),
      };
    });
  }

  stop(guildId: string): Promise<StopResult> {
    return this.#serialize(guildId, async () => {
      const session = this.#sessions.get(guildId);
      if (!session || (!session.current && session.upcoming.length === 0)) {
        throw new PlaybackRequestError(
          'There is no playback or queue to stop.',
        );
      }

      const result = {
        stopped: session.current?.track,
        removedUpcoming: session.upcoming.length,
      };
      this.#disposePlayback(session);
      session.current = undefined;
      session.upcoming = [];
      session.generation += 1;
      session.failedGeneration = undefined;
      session.controller.stop();
      this.#scheduleDisconnect(guildId, session);
      return result;
    });
  }

  disconnect(guildId: string): Promise<QueueSnapshot> {
    return this.#serialize(guildId, async () => {
      const session = this.#sessions.get(guildId);
      if (!session) {
        throw new PlaybackRequestError(
          'The bot is not connected to a voice channel.',
        );
      }
      const snapshot = snapshotOf(session);
      this.#destroySession(guildId, session);
      return snapshot;
    });
  }

  setVoiceChannelEmpty(guildId: string, empty: boolean): Promise<void> {
    return this.#serialize(guildId, async () => {
      const session = this.#sessions.get(guildId);
      if (!session) return;

      if (session.emptyChannelTimer) clearTimeout(session.emptyChannelTimer);
      session.emptyChannelTimer = undefined;
      if (!empty) return;

      session.emptyChannelTimer = setTimeout(() => {
        void this.#serialize(guildId, async () => {
          const current = this.#sessions.get(guildId);
          if (current === session) this.#destroySession(guildId, session);
        });
      }, this.#emptyChannelGraceMs);
      session.emptyChannelTimer.unref();
    });
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.#locks.values()]);
    for (const [guildId, session] of this.#sessions) {
      this.#destroySession(guildId, session);
    }
  }

  async #createSession(
    context: VoiceRequestContext,
  ): Promise<GuildPlaybackSession> {
    const controller = await this.#runtime.connect(context, {
      onIdle: (generation) => this.#handleIdle(context.guildId, generation),
      onError: (generation, error) =>
        this.#handlePlaybackError(context.guildId, generation, error),
      onConnectionLost: (error) =>
        this.#handleConnectionLost(context.guildId, error),
    });
    return {
      controller,
      voiceChannelId: context.voiceChannelId,
      notify: context.notify,
      upcoming: [],
      generation: 0,
    };
  }

  async #startNext(
    guildId: string,
    session: GuildPlaybackSession,
  ): Promise<void> {
    // A broken item should not strand the rest of the queue.
    while (!session.current && session.upcoming.length > 0) {
      const queued = session.upcoming.shift();
      if (!queued) break;

      session.current = queued;
      session.generation += 1;
      session.failedGeneration = undefined;
      const generation = session.generation;
      const playbackAbort = new AbortController();
      session.playbackAbort = playbackAbort;
      let source;

      try {
        source = await this.provider.createPlaybackStream(
          queued.track,
          playbackAbort.signal,
        );
        const pipeline = this.#runtime.createPipeline(
          source,
          queued.track,
          (error) => {
            void this.#handlePlaybackError(guildId, generation, error);
          },
        );
        session.pipeline = pipeline;
        session.controller.play(pipeline.resource, generation);
        return;
      } catch (error) {
        this.#disposePlayback(session);
        source?.destroy();
        this.#logger.error('track_start_failed', error, {
          guildId,
          trackId: queued.track.id,
        });
        session.current = undefined;
        await queued
          .notify(
            `Could not play **${escapeMarkdown(queued.track.title)}**; skipping it.`,
          )
          .catch(() => undefined);
      }
    }

    if (!session.current) this.#scheduleDisconnect(guildId, session);
  }

  #handleIdle(guildId: string, generation: number): Promise<void> {
    return this.#serialize(guildId, async () => {
      const session = this.#sessions.get(guildId);
      if (!session || session.generation !== generation) return;

      this.#disposePlayback(session);
      session.current = undefined;
      await this.#startNext(guildId, session);
    });
  }

  #handlePlaybackError(
    guildId: string,
    generation: number,
    error: Error,
  ): Promise<void> {
    return this.#serialize(guildId, async () => {
      const session = this.#sessions.get(guildId);
      if (
        !session ||
        !session.current ||
        session.generation !== generation ||
        session.failedGeneration === generation
      )
        return;
      // The source, FFmpeg, and Discord player can all report the same failure.
      session.failedGeneration = generation;

      const failed = session.current;
      this.#logger.error('track_playback_failed', error, {
        guildId,
        trackId: session.current?.track.id,
      });
      this.#disposePlayback(session);
      session.current = undefined;
      session.controller.stop();

      if (failed) {
        await failed
          .notify(
            `Playback failed for **${escapeMarkdown(failed.track.title)}**; skipping it.`,
          )
          .catch(() => undefined);
      }
      await this.#startNext(guildId, session);
    });
  }

  #handleConnectionLost(guildId: string, error: Error): Promise<void> {
    return this.#serialize(guildId, async () => {
      const session = this.#sessions.get(guildId);
      if (!session) return;
      this.#logger.error('voice_connection_lost', error, { guildId });
      const notify = session.current?.notify;
      this.#destroySession(guildId, session);
      if (notify) {
        await notify(
          'The voice connection was lost and could not recover. Playback was cleared.',
        ).catch(() => undefined);
      }
    });
  }

  #scheduleDisconnect(guildId: string, session: GuildPlaybackSession): void {
    if (session.disconnectTimer) clearTimeout(session.disconnectTimer);
    session.disconnectTimer = setTimeout(() => {
      void this.#serialize(guildId, async () => {
        if (
          this.#sessions.get(guildId) === session &&
          !session.current &&
          session.upcoming.length === 0
        ) {
          const notify = session.notify;
          this.#destroySession(guildId, session);
          await notify(idleDisconnectMessage()).catch(() => undefined);
        }
      });
    }, this.#emptyDisconnectMs);
    session.disconnectTimer.unref();
  }

  #destroySession(guildId: string, session: GuildPlaybackSession): void {
    if (session.disconnectTimer) clearTimeout(session.disconnectTimer);
    if (session.emptyChannelTimer) clearTimeout(session.emptyChannelTimer);
    this.#disposePlayback(session);
    session.controller.destroy();
    if (this.#sessions.get(guildId) === session) this.#sessions.delete(guildId);
  }

  #disposePlayback(session: GuildPlaybackSession): void {
    session.playbackAbort?.abort();
    session.playbackAbort = undefined;
    session.pipeline?.dispose();
    session.pipeline = undefined;
  }

  #requireCurrentSession(
    guildId: string,
    action: string,
  ): GuildPlaybackSession {
    const session = this.#sessions.get(guildId);
    if (!session?.current) {
      throw new PlaybackRequestError(`There is no active track to ${action}.`);
    }
    return session;
  }

  #serialize<T>(guildId: string, operation: () => Promise<T>): Promise<T> {
    // Commands, timers, and player callbacks may race within one guild. Chaining
    // them per guild keeps state transitions atomic without blocking other guilds.
    const previous = this.#locks.get(guildId) || Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const barrier = result.then(
      () => undefined,
      () => undefined,
    );
    this.#locks.set(guildId, barrier);
    void barrier.finally(() => {
      if (this.#locks.get(guildId) === barrier) this.#locks.delete(guildId);
    });
    return result;
  }
}

function snapshotOf(session: GuildPlaybackSession): QueueSnapshot {
  return {
    current: session.current?.track,
    upcoming: session.upcoming.map(({ track }) => track),
  };
}
