import { SlashCommandBuilder } from 'discord.js';
import type { PlaybackManager } from '../playback-manager.js';
import { disconnectMessage } from '../presentation/playback-responses.js';
import { commandSucceeded, type Command } from './command.js';
import { executeVoiceControl } from './voice-control.js';

export const disconnectDefinition = new SlashCommandBuilder()
  .setName('disconnect')
  .setDescription('Clear playback and disconnect from voice immediately.');

export function createDisconnectCommand(playback: PlaybackManager): Command {
  return {
    definition: disconnectDefinition,
    execute: (interaction) =>
      executeVoiceControl(
        interaction,
        playback,
        (guildId) => playback.disconnect(guildId),
        disconnectMessage,
        () => commandSucceeded('disconnected'),
      ),
  };
}
