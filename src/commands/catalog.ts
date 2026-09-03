import type { MediaProvider, PlaylistProvider } from '../media.js';
import type { PlaybackManager } from '../playback-manager.js';
import type { Command, CommandDefinition } from './command.js';
import { createDisconnectCommand, disconnectDefinition } from './disconnect.js';
import { createPauseCommand, pauseDefinition } from './pause.js';
import {
  createPlayCommand,
  createPlayNextCommand,
  playDefinition,
  playNextDefinition,
} from './play.js';
import { createPlaylistCommand, playlistDefinition } from './playlist.js';
import { createQueueCommand, queueDefinition } from './queue.js';
import { createRemoveCommand, removeDefinition } from './remove.js';
import { createResumeCommand, resumeDefinition } from './resume.js';
import { createSkipCommand, skipDefinition } from './skip.js';
import { createStopCommand, stopDefinition } from './stop.js';

// Deployment and runtime routing share this catalog to prevent command drift.
export const commandDefinitions = Object.freeze([
  playDefinition,
  playNextDefinition,
  playlistDefinition,
  pauseDefinition,
  resumeDefinition,
  skipDefinition,
  removeDefinition,
  stopDefinition,
  disconnectDefinition,
  queueDefinition,
]);

export type CommandDeploymentTarget = 'test' | 'global';

const TEST_COMMAND_SUFFIX = '-test';
const TEST_DESCRIPTION_PREFIX = '[TEST] ';

export function commandPayloadsFor(
  target: CommandDeploymentTarget,
): ReturnType<CommandDefinition['toJSON']>[] {
  return commandDefinitions.map((definition) => {
    const payload = definition.toJSON();
    if (target === 'global') return payload;

    return {
      ...payload,
      name: `${payload.name}${TEST_COMMAND_SUFFIX}`,
      description: `${TEST_DESCRIPTION_PREFIX}${payload.description}`,
    };
  });
}

export function createCommandMap(
  provider: MediaProvider & PlaylistProvider,
  playback: PlaybackManager,
): ReadonlyMap<string, Command> {
  const commands = [
    createPlayCommand(provider, playback),
    createPlayNextCommand(provider, playback),
    createPlaylistCommand(provider, playback),
    createPauseCommand(playback),
    createResumeCommand(playback),
    createSkipCommand(playback),
    createRemoveCommand(playback),
    createStopCommand(playback),
    createDisconnectCommand(playback),
    createQueueCommand(playback),
  ];
  return new Map(
    commands.flatMap((command) => [
      [command.definition.name, command] as const,
      [`${command.definition.name}${TEST_COMMAND_SUFFIX}`, command] as const,
    ]),
  );
}
