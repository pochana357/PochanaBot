import {
  MessageFlags,
  SlashCommandBuilder,
  type GuildMember,
} from 'discord.js';
import type { DiscordGatewayAdapterCreator } from '@discordjs/voice';
import { MediaInputError, type MediaProvider } from '../media.js';
import {
  PlaybackRequestError,
  type EnqueuePlacement,
  type PlaybackManager,
} from '../playback-manager.js';
import { buildPlayAcknowledgement } from '../presentation/playback-responses.js';
import {
  commandFailed,
  commandRejected,
  commandSucceeded,
  type Command,
  type CommandDefinition,
} from './command.js';

function createPlayDefinition(
  name: string,
  description: string,
): CommandDefinition {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .addStringOption((option) =>
      option
        .setName('query')
        .setDescription('A YouTube video URL or search query.')
        .setRequired(true),
    );
}

export const playDefinition = createPlayDefinition(
  'play',
  'Play a YouTube video or search result in your voice channel.',
);

export const playNextDefinition = createPlayDefinition(
  'play-next',
  'Play a YouTube video or search result next in your voice channel.',
);

export function createPlayCommand(
  provider: MediaProvider,
  playback: PlaybackManager,
): Command {
  return createSingleTrackCommand(playDefinition, 'back', provider, playback);
}

export function createPlayNextCommand(
  provider: MediaProvider,
  playback: PlaybackManager,
): Command {
  return createSingleTrackCommand(
    playNextDefinition,
    'front',
    provider,
    playback,
  );
}

function createSingleTrackCommand(
  definition: CommandDefinition,
  placement: EnqueuePlacement,
  provider: MediaProvider,
  playback: PlaybackManager,
): Command {
  return {
    definition,
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

      const query = interaction.options.getString('query', true);
      if (!provider.supports(query)) {
        await interaction.reply({
          content:
            'Provide a YouTube video link or a plain-text YouTube search.',
          flags: MessageFlags.Ephemeral,
        });
        return commandRejected('unsupported_input');
      }

      // Keep lookup errors private; only a successful queue change is announced
      // in the shared text channel below.
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      try {
        const [track] = await provider.resolve(query, {
          id: interaction.user.id,
          displayName: member.displayName,
        });
        if (!track)
          throw new MediaInputError('No playable YouTube result was found.');

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
          [track],
          { placement },
        );

        const acknowledgement = buildPlayAcknowledgement(
          track,
          result.started,
          result.position,
          placement,
        );
        if (interaction.channel?.isTextBased()) {
          await interaction.channel.send({ embeds: [acknowledgement] });
          await interaction.deleteReply();
        } else {
          await interaction.editReply({ embeds: [acknowledgement] });
        }
        return commandSucceeded(result.started ? 'started' : 'queued', {
          trackId: track.id,
          queuePosition: result.position,
        });
      } catch (error) {
        const message =
          error instanceof MediaInputError ||
          error instanceof PlaybackRequestError
            ? error.message
            : 'Playback could not be started. Please try again in a moment.';
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
