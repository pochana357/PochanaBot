import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { voiceSelectedMessage } from '../presentation/tts-responses.js';
import { presetChoices } from '../tts/presets.js';
import { TtsError } from '../tts/tts.js';
import type { TtsService } from '../tts/tts-service.js';
import {
  commandFailed,
  commandRejected,
  commandSucceeded,
  type Command,
} from './command.js';

export const presetTtsDefinition = new SlashCommandBuilder()
  .setName('preset-tts')
  .setDescription(
    'Choose the voice used by /tts. (Fish Audio: more expressive but usage-limited. Microsoft Edge: free)',
  )
  .addStringOption((option) =>
    option
      .setName('preset')
      .setDescription('An engine and voice combination.')
      .setRequired(true)
      .addChoices(...presetChoices()),
  );

export function createPresetTtsCommand(tts: TtsService): Command {
  return {
    definition: presetTtsDefinition,
    async execute(interaction) {
      const presetId = interaction.options.getString('preset', true);
      try {
        const preset = tts.selectPreset(interaction.user.id, presetId);
        await interaction.reply({
          content: voiceSelectedMessage(preset.label),
          flags: MessageFlags.Ephemeral,
        });
        return commandSucceeded('voice_set', {
          presetId: preset.id,
          engine: preset.engine,
        });
      } catch (error) {
        if (!(error instanceof TtsError)) return commandFailed(error);
        await interaction.reply({
          content: error.message,
          flags: MessageFlags.Ephemeral,
        });
        return commandRejected('unknown_voice');
      }
    },
  };
}
