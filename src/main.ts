import { performance } from 'node:perf_hooks';
import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  type InteractionReplyOptions,
} from 'discord.js';
import {
  commandLogContext,
  logCommandReceived,
  logCommandResult,
} from './command-logging.js';
import { createCommandMap } from './commands/catalog.js';
import { commandFailed } from './commands/command.js';
import { handleQueueButton } from './commands/queue.js';
import { requireEnvironment } from './config.js';
import { logger } from './logger.js';
import { PlaybackManager } from './playback-manager.js';
import { YouTubeMediaProvider } from './providers/youtube.js';

const provider = new YouTubeMediaProvider();
const playback = new PlaybackManager(provider);
const commands = createCommandMap(provider, playback);

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once(Events.ClientReady, (readyClient) => {
  logger.info('bot_ready', {
    userId: readyClient.user.id,
    userTag: readyClient.user.tag,
    guildCount: readyClient.guilds.cache.size,
  });
});

client.on(Events.Error, (error) => {
  logger.error('discord_client_error', error);
});

client.on(Events.Invalidated, () => {
  logger.error('discord_session_invalidated');
});

client.on(Events.ShardDisconnect, (closeEvent, shardId) => {
  logger.info('discord_shard_disconnected', {
    shardId,
    code: closeEvent.code,
    reason: closeEvent.reason,
    wasClean: closeEvent.wasClean,
  });
});

client.on(Events.ShardReady, (shardId, unavailableGuilds) => {
  logger.info('discord_shard_ready', {
    shardId,
    unavailableGuildCount: unavailableGuilds?.size || 0,
  });
});

client.on(Events.ShardReconnecting, (shardId) => {
  logger.info('discord_shard_reconnecting', { shardId });
});

client.on(Events.ShardResume, (shardId, replayedEvents) => {
  logger.info('discord_shard_resumed', { shardId, replayedEvents });
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (
    interaction.isButton() &&
    (await handleQueueButton(interaction, playback, logger))
  )
    return;
  if (!interaction.isChatInputCommand()) return;
  const command = commands.get(interaction.commandName);
  if (!command) return;
  const context = commandLogContext(interaction);
  const startedAt = performance.now();
  logCommandReceived(logger, context);

  try {
    const result = await command.execute(interaction);
    logCommandResult(logger, context, result, performance.now() - startedAt);
  } catch (error) {
    logCommandResult(
      logger,
      context,
      commandFailed(error),
      performance.now() - startedAt,
    );
    const response: InteractionReplyOptions = {
      content: 'The command failed unexpectedly. Please try again.',
      flags: MessageFlags.Ephemeral,
    };
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(response).catch(() => undefined);
    } else {
      await interaction.reply(response).catch(() => undefined);
    }
  }
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  const guild = newState.guild;
  const activeChannelId = playback.channelId(guild.id);
  if (!activeChannelId) return;
  // Ignore voice changes elsewhere; only membership in the bot's channel affects
  // its empty-channel grace timer.
  if (
    oldState.channelId !== activeChannelId &&
    newState.channelId !== activeChannelId
  )
    return;

  const channel = guild.channels.cache.get(activeChannelId);
  if (!channel?.isVoiceBased()) return;
  const hasHumanListener = channel.members.some((member) => !member.user.bot);
  void playback.setVoiceChannelEmpty(guild.id, !hasHumanListener);
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  // Signal handlers may fire more than once while asynchronous cleanup is running.
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('shutdown_started', { signal });
  await playback.shutdown();
  client.destroy();
  logger.info('shutdown_complete', { signal });
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown(signal).catch((error) => {
      logger.error('shutdown_failed', error, { signal });
      client.destroy();
      process.exitCode = 1;
    });
  });
}

try {
  await client.login(requireEnvironment('DISCORD_TOKEN'));
} catch (error) {
  logger.error('bot_login_failed', error);
  await playback.shutdown();
  client.destroy();
  process.exitCode = 1;
}
