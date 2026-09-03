import type { DiscordGatewayAdapterCreator } from '@discordjs/voice';
import {
  MessageFlags,
  SlashCommandBuilder,
  type GuildMember,
} from 'discord.js';
import { MediaInputError, type PlaylistProvider } from '../media.js';
import {
  PlaybackRequestError,
  type PlaybackManager,
} from '../playback-manager.js';
import { playlistMessage } from '../presentation/playback-responses.js';
import {
  commandFailed,
  commandRejected,
  commandSucceeded,
  type Command,
} from './command.js';

export const playlistDefinition = new SlashCommandBuilder()
  .setName('playlist')
  .setDescription('Add a YouTube playlist to the playback queue.')
  .addStringOption((option) =>
    option
      .setName('url')
      .setDescription('A playlist URL or a YouTube watch URL with a playlist.')
      .setRequired(true),
  );

export function createPlaylistCommand(
  provider: PlaylistProvider,
  playback: PlaybackManager,
): Command {
  return {
    definition: playlistDefinition,
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

      const url = interaction.options.getString('url', true);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      try {
        const tracks = await provider.resolvePlaylist(url, {
          id: interaction.user.id,
          displayName: member.displayName,
        });
        if (tracks.length === 0) {
          throw new MediaInputError(
            'No playable videos were found in that YouTube playlist.',
          );
        }

        const result = await playback.enqueue(
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
          tracks,
        );

        const acknowledgement = playlistMessage(
          tracks.length,
          result.started,
          result.position,
          url,
        );
        if (interaction.channel?.isTextBased()) {
          await interaction.channel.send({ content: acknowledgement });
          await interaction.deleteReply();
        } else {
          await interaction.editReply({ content: acknowledgement });
        }
        return commandSucceeded(result.started ? 'started' : 'queued', {
          trackCount: tracks.length,
          queuePosition: result.position,
        });
      } catch (error) {
        const message =
          error instanceof MediaInputError ||
          error instanceof PlaybackRequestError
            ? error.message
            : 'The playlist could not be added. Please try again in a moment.';
        await interaction.editReply({ content: message });
        if (error instanceof MediaInputError)
          return commandRejected('media_rejected');
        if (error instanceof PlaybackRequestError)
          return commandRejected('playback_rejected');
        return commandFailed(error);
      }
    },
  };
}
