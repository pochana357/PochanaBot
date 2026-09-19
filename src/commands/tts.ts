import {
  MessageFlags,
  SlashCommandBuilder,
  type GuildMember,
} from 'discord.js';
import type { DiscordGatewayAdapterCreator } from '@discordjs/voice';
import {
  PlaybackRequestError,
  type PlaybackManager,
} from '../playback-manager.js';
import {
  speakingMessage,
  speechQueuedMessage,
} from '../presentation/tts-responses.js';
import { TtsError } from '../tts/tts.js';
import { MAX_TTS_TEXT_LENGTH, TtsService } from '../tts/tts-service.js';
import {
  commandFailed,
  commandRejected,
  commandSucceeded,
  type Command,
} from './command.js';

export const ttsDefinition = new SlashCommandBuilder()
  .setName('tts')
  .setDescription('Speak a message in your voice channel.')
  .addStringOption((option) =>
    option
      .setName('text')
      .setDescription('The message to speak.')
      .setRequired(true)
      .setMaxLength(MAX_TTS_TEXT_LENGTH),
  );

export function createTtsCommand(
  tts: TtsService,
  playback: PlaybackManager,
): Command {
  return {
    definition: ttsDefinition,
    async execute(interaction) {
      if (!interaction.inCachedGuild()) {
        await interaction.reply({
          content: 'This command can only be used in a Discord server.',
          flags: MessageFlags.Ephemeral,
        });
        return commandRejected('guild_only');
      }

      const member = interaction.member as GuildMember;
      const voiceChannel = member.voice.channel;
      if (!voiceChannel) {
        await interaction.reply({
          content: `Join a voice channel before using \`/${interaction.commandName}\`.`,
          flags: MessageFlags.Ephemeral,
        });
        return commandRejected('not_in_voice');
      }

      const activeChannelId = playback.channelId(interaction.guildId);
      if (activeChannelId && activeChannelId !== voiceChannel.id) {
        await interaction.reply({
          content: 'Join the voice channel that the bot is already using.',
          flags: MessageFlags.Ephemeral,
        });
        return commandRejected('different_voice_channel');
      }

      // Synthesis runs well past Discord's three-second interaction window.
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const preset = tts.presetFor(interaction.user.id);
      try {
        const text = TtsService.normalizeText(
          interaction.options.getString('text', true),
        );
        const result = await playback.speak(
          {
            guildId: interaction.guildId,
            voiceChannelId: voiceChannel.id,
            adapterCreator: interaction.guild
              .voiceAdapterCreator as DiscordGatewayAdapterCreator,
            notify: async (message) =>
              interaction.channel?.isTextBased()
                ? interaction.channel.send(message)
                : undefined,
          },
          {
            text,
            preset,
            requestedBy: {
              id: interaction.user.id,
              displayName: member.displayName,
            },
          },
        );

        // Announce what is being spoken where everyone can see it. This is
        // best effort: the audio is already playing, so failing to post must
        // not be reported back as a failure to speak.
        const announced =
          result.started && interaction.channel?.isTextBased()
            ? await interaction.channel
                .send(speakingMessage(text, preset.label))
                .then(() => true)
                .catch(() => false)
            : false;
        if (announced) {
          await interaction.deleteReply().catch(() => undefined);
        } else {
          await interaction
            .editReply({
              content: result.started
                ? speakingMessage(text, preset.label)
                : speechQueuedMessage(result.position),
            })
            .catch(() => undefined);
        }
        return commandSucceeded('spoken', {
          presetId: preset.id,
          engine: preset.engine,
          started: result.started,
        });
      } catch (error) {
        const rejected =
          error instanceof TtsError || error instanceof PlaybackRequestError;
        await interaction.editReply({
          content: rejected
            ? error.message
            : 'The message could not be spoken. Please try again in a moment.',
        });
        if (!rejected) return commandFailed(error);
        return commandRejected(
          error instanceof PlaybackRequestError && error.code === 'music_active'
            ? 'music_active'
            : 'tts_rejected',
        );
      }
    },
  };
}
