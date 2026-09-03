import {
  MessageFlags,
  type ChatInputCommandInteraction,
  type GuildMember,
} from 'discord.js';
import {
  PlaybackRequestError,
  type PlaybackManager,
} from '../playback-manager.js';
import {
  commandFailed,
  commandRejected,
  type CommandExecutionResult,
} from './command.js';

export async function executeVoiceControl<T>(
  interaction: ChatInputCommandInteraction,
  playback: PlaybackManager,
  action: (guildId: string) => Promise<T>,
  successMessage: (result: T) => string,
  successResult: (result: T) => CommandExecutionResult,
): Promise<CommandExecutionResult> {
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
      content: 'The bot is not connected to a voice channel.',
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

  try {
    const result = await action(interaction.guildId);
    await interaction.reply({ content: successMessage(result) });
    return successResult(result);
  } catch (error) {
    await interaction.reply({
      content:
        error instanceof PlaybackRequestError
          ? error.message
          : `The \`/${interaction.commandName}\` command failed unexpectedly.`,
      flags: MessageFlags.Ephemeral,
    });
    return error instanceof PlaybackRequestError
      ? commandRejected('playback_rejected')
      : commandFailed(error);
  }
}
