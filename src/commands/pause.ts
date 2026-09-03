import { SlashCommandBuilder } from 'discord.js';
import type { PlaybackManager } from '../playback-manager.js';
import { pauseMessage } from '../presentation/playback-responses.js';
import { commandSucceeded, type Command } from './command.js';
import { executeVoiceControl } from './voice-control.js';

export const pauseDefinition = new SlashCommandBuilder()
  .setName('pause')
  .setDescription('Pause the current track.');

export function createPauseCommand(playback: PlaybackManager): Command {
  return {
    definition: pauseDefinition,
    execute: (interaction) =>
      executeVoiceControl(
        interaction,
        playback,
        (guildId) => playback.pause(guildId),
        pauseMessage,
        () => commandSucceeded('paused'),
      ),
  };
}
