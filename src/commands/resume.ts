import { SlashCommandBuilder } from 'discord.js';
import type { PlaybackManager } from '../playback-manager.js';
import { resumeMessage } from '../presentation/playback-responses.js';
import { commandSucceeded, type Command } from './command.js';
import { executeVoiceControl } from './voice-control.js';

export const resumeDefinition = new SlashCommandBuilder()
  .setName('resume')
  .setDescription('Resume the paused track.');

export function createResumeCommand(playback: PlaybackManager): Command {
  return {
    definition: resumeDefinition,
    execute: (interaction) =>
      executeVoiceControl(
        interaction,
        playback,
        (guildId) => playback.resume(guildId),
        resumeMessage,
        () => commandSucceeded('resumed'),
      ),
  };
}
