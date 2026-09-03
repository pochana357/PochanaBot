import { SlashCommandBuilder } from 'discord.js';
import type { PlaybackManager } from '../playback-manager.js';
import { stopMessage } from '../presentation/playback-responses.js';
import { commandSucceeded, type Command } from './command.js';
import { executeVoiceControl } from './voice-control.js';

export const stopDefinition = new SlashCommandBuilder()
  .setName('stop')
  .setDescription('Stop playback and clear the queue without disconnecting.');

export function createStopCommand(playback: PlaybackManager): Command {
  return {
    definition: stopDefinition,
    execute: (interaction) =>
      executeVoiceControl(
        interaction,
        playback,
        (guildId) => playback.stop(guildId),
        stopMessage,
        (result) =>
          commandSucceeded('stopped', {
            clearedCount:
              Number(Boolean(result.stopped)) + result.removedUpcoming,
          }),
      ),
  };
}
