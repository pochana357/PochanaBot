import {
  MessageFlags,
  SlashCommandBuilder,
  type GuildMember,
} from 'discord.js';
import {
  PlaybackRequestError,
  type PlaybackManager,
} from '../playback-manager.js';
import { skipMessage } from '../presentation/playback-responses.js';
import {
  commandFailed,
  commandRejected,
  commandSucceeded,
  type Command,
} from './command.js';

export const skipDefinition = new SlashCommandBuilder()
  .setName('skip')
  .setDescription(
    'Skip the current track, or stop playback if the queue is empty.',
  );

export function createSkipCommand(playback: PlaybackManager): Command {
  return {
    definition: skipDefinition,
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
          content: `Join the bot’s voice channel before using \`/${interaction.commandName}\`.`,
          flags: MessageFlags.Ephemeral,
        });
        return commandRejected('not_in_voice');
      }

      const activeChannelId = playback.channelId(interaction.guildId);
      if (!activeChannelId) {
        await interaction.reply({
          content: 'There is no active track to skip.',
          flags: MessageFlags.Ephemeral,
        });
        return commandRejected('bot_not_connected');
      }
      if (activeChannelId !== voiceChannel.id) {
        await interaction.reply({
          content: 'Join the voice channel that the bot is already using.',
          flags: MessageFlags.Ephemeral,
        });
        return commandRejected('different_voice_channel');
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const result = await playback.skip(interaction.guildId);
        const acknowledgement = skipMessage(result);
        if (interaction.channel?.isTextBased()) {
          await interaction.channel.send({ content: acknowledgement });
          await interaction.deleteReply();
        } else {
          await interaction.editReply({ content: acknowledgement });
        }
        return commandSucceeded(result.startedNext ? 'advanced' : 'stopped');
      } catch (error) {
        const message =
          error instanceof PlaybackRequestError
            ? error.message
            : 'The current track could not be skipped. Please try again.';
        await interaction.editReply({ content: message });
        return error instanceof PlaybackRequestError
          ? commandRejected('playback_rejected')
          : commandFailed(error);
      }
    },
  };
}
