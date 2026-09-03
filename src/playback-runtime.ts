import type { Readable } from 'node:stream';
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  createAudioPlayer,
  entersState,
  joinVoiceChannel,
  type DiscordGatewayAdapterCreator,
} from '@discordjs/voice';
import { createAudioPipeline } from './audio/ffmpeg.js';
import type { Track } from './media.js';

const CONNECTION_TIMEOUT_MS = 15_000;

export type VoiceConnectionRequest = {
  guildId: string;
  voiceChannelId: string;
  adapterCreator: DiscordGatewayAdapterCreator;
};

export type PlaybackEvents = {
  onIdle(generation: number): void | Promise<void>;
  onError(generation: number, error: Error): void | Promise<void>;
  onConnectionLost(error: Error): void | Promise<void>;
};

export type PlaybackControllerState = 'idle' | 'playing' | 'paused';

export interface PlaybackController {
  play(resource: unknown, generation: number): void;
  state(): PlaybackControllerState;
  pause(): boolean;
  resume(): boolean;
  stop(): void;
  destroy(): void;
}

export interface PlaybackPipeline {
  readonly resource: unknown;
  dispose(): void;
}

export interface PlaybackRuntime {
  connect(
    request: VoiceConnectionRequest,
    events: PlaybackEvents,
  ): Promise<PlaybackController>;
  createPipeline(
    source: Readable,
    track: Track,
    onError: (error: Error) => void,
  ): PlaybackPipeline;
}

export class DiscordPlaybackRuntime implements PlaybackRuntime {
  async connect(
    request: VoiceConnectionRequest,
    events: PlaybackEvents,
  ): Promise<PlaybackController> {
    const connection = joinVoiceChannel({
      guildId: request.guildId,
      channelId: request.voiceChannelId,
      adapterCreator: request.adapterCreator,
      selfDeaf: true,
    });
    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Stop },
    });
    // Discord player events do not identify the resource that emitted them.
    let activeGeneration = 0;

    connection.subscribe(player);
    player.on(AudioPlayerStatus.Idle, () => {
      void events.onIdle(activeGeneration);
    });
    player.on('error', (error) => {
      void events.onError(activeGeneration, error);
    });
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        // Discord can disconnect briefly while negotiating a new voice server.
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch (cause) {
        void events.onConnectionLost(
          new Error('The voice connection could not recover.', { cause }),
        );
      }
    });

    try {
      await entersState(
        connection,
        VoiceConnectionStatus.Ready,
        CONNECTION_TIMEOUT_MS,
      );
    } catch (error) {
      player.stop(true);
      connection.destroy();
      throw new Error('The bot could not establish a voice connection.', {
        cause: error,
      });
    }

    return {
      play(resource, generation) {
        activeGeneration = generation;
        player.play(resource as Parameters<typeof player.play>[0]);
      },
      state() {
        if (player.state.status === AudioPlayerStatus.Playing) return 'playing';
        if (
          player.state.status === AudioPlayerStatus.Paused ||
          player.state.status === AudioPlayerStatus.AutoPaused
        )
          return 'paused';
        return 'idle';
      },
      pause() {
        return player.pause(true);
      },
      resume() {
        return player.unpause();
      },
      stop() {
        player.stop(true);
      },
      destroy() {
        player.stop(true);
        player.removeAllListeners();
        if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
          connection.destroy();
        }
      },
    };
  }

  createPipeline(
    source: Readable,
    track: Track,
    onError: (error: Error) => void,
  ): PlaybackPipeline {
    return createAudioPipeline(source, track, onError);
  }
}
