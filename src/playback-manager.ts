import type { DiscordGatewayAdapterCreator } from '@discordjs/voice';
import { logger as defaultLogger, type Logger } from './logger.js';
import type { MediaProvider, Requester, Track } from './media.js';
import { escapeMarkdown } from './presentation/discord-format.js';
import { idleDisconnectMessage } from './presentation/playback-responses.js';
import {
  droppedUtterancesMessage,
  musicActiveMessage,
  speechCancelledMessage,
  speechFailedMessage,
} from './presentation/tts-responses.js';
import type { SpeechSynthesizer } from './tts/tts-service.js';
import { TtsError, type TtsVoicePreset } from './tts/tts.js';
import {
  DiscordPlaybackRuntime,
  type PlaybackController,
  type PlaybackPipeline,
  type PlaybackRuntime,
} from './playback-runtime.js';

const DEFAULT_MAX_QUEUE_LENGTH = 500;
const DEFAULT_EMPTY_DISCONNECT_MS = 5 * 60_000;
const DEFAULT_MAX_SPEECH_QUEUE_LENGTH = 3;
// Deliberate listening-level default: unattenuated music is too loud at normal
// Discord/client volume. Deployments can override it through `musicVolume`.
const DEFAULT_MUSIC_VOLUME = 0.5;

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

export type SpeakResult = {
  started: boolean;
  position: number;
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

export type PlaybackRequestErrorCode = 'music_active';

export class PlaybackRequestError extends Error {
  readonly code?: PlaybackRequestErrorCode;

  constructor(
    message: string,
    options?: ErrorOptions & { code?: PlaybackRequestErrorCode },
  ) {
    super(message, options);
    this.name = 'PlaybackRequestError';
    this.code = options?.code;
  }
}

type QueuedTrack = {
  track: Track;
  // Keep the request's text-channel callback with the track so later failures are
  // reported where that track was originally queued.
  notify(message: string): Promise<unknown>;
};

export type Utterance = {
  text: string;
  preset: TtsVoicePreset;
  requestedBy: Requester;
};

type QueuedUtterance = Utterance & {
  notify(message: string): Promise<unknown>;
};

type SpeechClaim = {
  queued: QueuedUtterance;
  // The session the claim was made against. Generations restart at zero when a
  // session is recreated, so the number alone cannot prove ownership: an old
  // claim would otherwise match, and clear, a replacement session's first
  // utterance.
  session: GuildPlaybackSession;
  generation: number;
  signal: AbortSignal;
};

type GuildPlaybackSession = {
  controller: PlaybackController;
  voiceChannelId: string;
  notify(message: string): Promise<unknown>;
  current?: QueuedTrack;
  upcoming: QueuedTrack[];
  // Speech and music are mutually exclusive, so they share one generation
  // counter and one AudioPlayer.
  speaking?: QueuedUtterance;
  speechQueue: QueuedUtterance[];
  // True while a drive loop owns the speech queue, including the stretch when
  // synthesis is running outside the guild lock.
  speechDriving: boolean;
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
  maxSpeechQueueLength?: number;
  musicVolume?: number;
  speech?: SpeechSynthesizer;
  logger?: Pick<Logger, 'error'>;
};

export class PlaybackManager {
  readonly #sessions = new Map<string, GuildPlaybackSession>();
  readonly #locks = new Map<string, Promise<void>>();
  readonly #runtime: PlaybackRuntime;
  readonly #maxQueueLength: number;
  readonly #emptyDisconnectMs: number;
  readonly #emptyChannelGraceMs: number;
  readonly #maxSpeechQueueLength: number;
  readonly #musicVolume: number;
  readonly #speech?: SpeechSynthesizer;
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
    this.#maxSpeechQueueLength =
      options.maxSpeechQueueLength ?? DEFAULT_MAX_SPEECH_QUEUE_LENGTH;
    this.#musicVolume = options.musicVolume ?? DEFAULT_MUSIC_VOLUME;
    this.#speech = options.speech;
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

      const existing = this.#sessions.get(context.guildId);
      const existingCount = existing
        ? Number(Boolean(existing.current)) + existing.upcoming.length
        : 0;
      if (existingCount + tracks.length > this.#maxQueueLength) {
        throw new PlaybackRequestError(
          `The queue cannot contain more than ${this.#maxQueueLength} tracks.`,
        );
      }

      const session = await this.#ensureSession(context);
      // An utterance in progress defers music rather than being cut off.
      const started =
        !session.current &&
        !session.speaking &&
        !session.speechDriving &&
        session.upcoming.length === 0;
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

  async speak(
    context: VoiceRequestContext,
    utterance: Utterance,
  ): Promise<SpeakResult> {
    const speech = this.#speech;
    if (!speech) {
      throw new PlaybackRequestError('Text to speech is not configured.');
    }

    // Only the queue update happens under the guild lock. Synthesis runs
    // outside it, so /stop can take the lock and abort work in flight instead
    // of waiting out the engine's timeout.
    const reserved = await this.#serialize(context.guildId, async () => {
      const existing = this.#sessions.get(context.guildId);
      // Music owns the player outright; speech only fills idle time.
      if (existing?.current) {
        throw new PlaybackRequestError(musicActiveMessage(), {
          code: 'music_active',
        });
      }
      if (
        existing &&
        existing.speechQueue.length >= this.#maxSpeechQueueLength
      ) {
        throw new PlaybackRequestError(
          `Only ${this.#maxSpeechQueueLength} messages can wait to be spoken.`,
        );
      }

      const session = await this.#ensureSession(context);
      session.speechQueue.push({ ...utterance, notify: context.notify });
      const started = !session.speaking && !session.speechDriving;
      if (started) session.speechDriving = true;
      return { session, started, position: session.speechQueue.length };
    });

    // A drive loop already running will pick this utterance up.
    if (!reserved.started)
      return { started: false, position: reserved.position };

    let spoke: boolean;
    try {
      spoke = await this.#driveSpeech(
        context.guildId,
        reserved.session,
        speech,
        true,
      );
    } catch (error) {
      throw error instanceof TtsError
        ? new PlaybackRequestError(error.message, { cause: error })
        : error;
    }
    // The claim was discarded before it reached the player, because /stop or
    // anything else that moves the session on won the lock while synthesis ran.
    // Returning success here would publicly announce audio nobody heard.
    if (!spoke) throw new PlaybackRequestError(speechCancelledMessage());
    return { started: true, position: reserved.position };
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
      if (
        !session ||
        (!session.current &&
          !session.speaking &&
          session.upcoming.length === 0 &&
          session.speechQueue.length === 0)
      ) {
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
      session.speaking = undefined;
      session.speechQueue = [];
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
      speechQueue: [],
      speechDriving: false,
      generation: 0,
    };
  }

  async #ensureSession(
    context: VoiceRequestContext,
  ): Promise<GuildPlaybackSession> {
    let session = this.#sessions.get(context.guildId);
    if (session && session.voiceChannelId !== context.voiceChannelId) {
      throw new PlaybackRequestError(
        'The bot is already active in a different voice channel.',
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
    return session;
  }

  async #startNext(
    guildId: string,
    session: GuildPlaybackSession,
  ): Promise<void> {
    // Music waits for the current utterance, including one still being
    // synthesized, rather than cutting it off.
    if (session.speaking || session.speechDriving) return;

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
          { volume: this.#musicVolume },
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

    if (
      !session.current &&
      !session.speaking &&
      !session.speechDriving &&
      session.speechQueue.length === 0
    ) {
      this.#scheduleDisconnect(guildId, session);
    }
  }

  /**
   * Claims an utterance under the lock, synthesizes and decodes it outside the
   * lock, then commits it under the lock again. The claim reserves
   * `session.speaking` up front so /stop can abort work that is still in
   * flight, and the generation check on commit discards anything it superseded.
   *
   * Resolves true only when the *first* utterance reached the player, which is
   * what `speak` reports to its caller; later ones belong to a caller that has
   * already returned.
   */
  async #driveSpeech(
    guildId: string,
    owner: GuildPlaybackSession,
    speech: SpeechSynthesizer,
    rethrowFirst: boolean,
  ): Promise<boolean> {
    let failure: unknown;
    let first = true;

    try {
      for (;;) {
        const claim = await this.#claimUtterance(guildId, owner);
        if (!claim) break;

        try {
          const audio = await speech.synthesize(
            claim.queued.text,
            claim.queued.preset,
            claim.signal,
          );
          // Decoding here is what makes a well-formed response that is not
          // decodable audio fail before playback is acknowledged.
          const pipeline = await this.#runtime.createSpeechPipeline(
            audio.data,
            claim.queued,
            claim.signal,
          );
          if (await this.#commitSpeech(guildId, claim, pipeline)) return first;
          break;
        } catch (error) {
          this.#logger.error('speech_start_failed', error, { guildId });
          await this.#releaseClaim(guildId, claim);
          if (first && rethrowFirst) {
            failure = error;
            break;
          }
          await claim.queued
            .notify(
              speechFailedMessage(
                error instanceof TtsError ? error.message : 'Please try again.',
              ),
            )
            .catch(() => undefined);
        }
        first = false;
      }
    } finally {
      await this.#stopDriving(guildId, owner);
    }

    if (failure !== undefined) throw failure;
    return false;
  }

  #claimUtterance(
    guildId: string,
    owner: GuildPlaybackSession,
  ): Promise<SpeechClaim | undefined> {
    return this.#serialize(guildId, async () => {
      const session = this.#sessions.get(guildId);
      if (!session || session !== owner || session.speaking || session.current)
        return undefined;
      const queued = session.speechQueue.shift();
      if (!queued) return undefined;

      session.generation += 1;
      session.failedGeneration = undefined;
      const playbackAbort = new AbortController();
      session.playbackAbort = playbackAbort;
      // Reserved before synthesis starts so /stop can see it and abort.
      session.speaking = queued;
      return {
        queued,
        session,
        generation: session.generation,
        signal: playbackAbort.signal,
      };
    });
  }

  #commitSpeech(
    guildId: string,
    claim: SpeechClaim,
    pipeline: PlaybackPipeline,
  ): Promise<boolean> {
    return this.#serialize(guildId, async () => {
      const session = this.#sessions.get(guildId);
      // Anything that moved the session on while synthesis ran wins, and a
      // recreated session is never the one this claim belongs to.
      if (
        !session ||
        session !== claim.session ||
        session.generation !== claim.generation ||
        session.speaking !== claim.queued
      ) {
        pipeline.dispose();
        return false;
      }
      session.pipeline = pipeline;
      session.controller.play(pipeline.resource, claim.generation);
      return true;
    });
  }

  #releaseClaim(guildId: string, claim: SpeechClaim): Promise<void> {
    return this.#serialize(guildId, async () => {
      const session = this.#sessions.get(guildId);
      if (
        !session ||
        session !== claim.session ||
        session.generation !== claim.generation
      )
        return;
      this.#disposePlayback(session);
      session.speaking = undefined;
    });
  }

  #stopDriving(guildId: string, owner: GuildPlaybackSession): Promise<void> {
    return this.#serialize(guildId, async () => {
      if (this.#sessions.get(guildId) !== owner) return;
      owner.speechDriving = false;
      // The loop can stop with the queue still populated: a first failure is
      // rethrown to its caller instead of drained, and a superseded claim ends
      // it too. Advancing here is what keeps the rest from being stranded,
      // never spoken and holding the idle-disconnect timer off forever.
      if (!owner.speaking && !owner.current) {
        await this.#advance(guildId, owner);
      }
    });
  }

  #handleIdle(guildId: string, generation: number): Promise<void> {
    return this.#serialize(guildId, async () => {
      const session = this.#sessions.get(guildId);
      if (!session || session.generation !== generation) return;

      this.#disposePlayback(session);
      if (session.speaking) {
        session.speaking = undefined;
        await this.#advance(guildId, session);
        return;
      }
      session.current = undefined;
      await this.#advance(guildId, session);
    });
  }

  /**
   * Decides what the player does next whenever an item finishes or fails.
   * Queued music takes priority the moment an utterance ends, so speech never
   * delays a track by more than one utterance; otherwise a waiting speech queue
   * resumes, and only a session with nothing left at all arms the idle timer.
   */
  async #advance(
    guildId: string,
    session: GuildPlaybackSession,
  ): Promise<void> {
    if (session.upcoming.length > 0) {
      const dropped = session.speechQueue.length;
      session.speechQueue = [];
      if (dropped > 0) {
        await session
          .notify(droppedUtterancesMessage(dropped))
          .catch(() => undefined);
      }
      await this.#startNext(guildId, session);
      return;
    }
    const speech = this.#speech;
    if (speech && session.speechQueue.length > 0 && !session.speechDriving) {
      session.speechDriving = true;
      // This runs inside the guild lock, so the loop is launched rather than
      // awaited; its first step takes the lock once this operation releases it.
      void this.#driveSpeech(guildId, session, speech, false).catch(
        () => undefined,
      );
      return;
    }
    await this.#startNext(guildId, session);
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
        (!session.current && !session.speaking) ||
        session.generation !== generation ||
        session.failedGeneration === generation
      )
        return;
      // The source, FFmpeg, and Discord player can all report the same failure.
      session.failedGeneration = generation;

      const spoken = session.speaking;
      if (spoken) {
        this.#logger.error('speech_playback_failed', error, { guildId });
        this.#disposePlayback(session);
        session.speaking = undefined;
        session.controller.stop();
        await spoken
          .notify(speechFailedMessage('The audio could not be played.'))
          .catch(() => undefined);
        await this.#advance(guildId, session);
        return;
      }

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
      await this.#advance(guildId, session);
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
          !session.speaking &&
          !session.speechDriving &&
          session.upcoming.length === 0 &&
          session.speechQueue.length === 0
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
    session.speaking = undefined;
    session.speechQueue = [];
    session.speechDriving = false;
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
