import { SlashCommandBuilder } from 'discord.js';
import {
  PlaybackRequestError,
  type PlaybackManager,
} from '../playback-manager.js';
import { removeMessage } from '../presentation/playback-responses.js';
import { commandSucceeded, type Command } from './command.js';
import { executeVoiceControl } from './voice-control.js';

export const removeDefinition = new SlashCommandBuilder()
  .setName('remove')
  .setDescription('Remove one or more upcoming tracks from the queue.')
  .addStringOption((option) =>
    option
      .setName('tracks')
      .setDescription(
        'A queue position or inclusive range, such as 12 or 12-20.',
      )
      .setMaxLength(25)
      .setRequired(true),
  );

export function createRemoveCommand(playback: PlaybackManager): Command {
  return {
    definition: removeDefinition,
    execute(interaction) {
      const selection = interaction.options.getString('tracks', true);
      return executeVoiceControl(
        interaction,
        playback,
        (guildId) => {
          const { start, end } = parseTrackSelection(selection);
          return playback.remove(guildId, start, end);
        },
        removeMessage,
        (result) =>
          commandSucceeded('removed', { removedCount: result.removed.length }),
      );
    },
  };
}

export function parseTrackSelection(selection: string): {
  start: number;
  end: number;
} {
  const match = /^([1-9]\d*)(?:\s*-\s*([1-9]\d*))?$/.exec(selection.trim());
  if (!match) throw invalidSelection();

  const start = Number(match[1]);
  const end = Number(match[2] || match[1]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    end < start
  ) {
    throw invalidSelection();
  }
  return { start, end };
}

function invalidSelection(): PlaybackRequestError {
  return new PlaybackRequestError(
    'Use a queue position or range such as `12` or `12-20`.',
  );
}
