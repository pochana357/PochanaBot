import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  SlashCommandBuilder,
  type ButtonInteraction,
} from 'discord.js';
import type { Logger } from '../logger.js';
import type { PlaybackManager, QueueSnapshot } from '../playback-manager.js';
import {
  buildQueueEmbed,
  buildQueuePageEmbed,
  QUEUE_PAGE_SIZE,
  queuePageCount,
} from '../presentation/playback-responses.js';
import { commandRejected, commandSucceeded, type Command } from './command.js';

export const QUEUE_BROWSE_CUSTOM_ID = 'queue:v1:browse';
const QUEUE_PAGE_CUSTOM_ID =
  /^queue:v1:page:(first|previous|next|last):([1-9]\d*)$/;

type QueuePageAction = 'first' | 'previous' | 'next' | 'last';

export const queueDefinition = new SlashCommandBuilder()
  .setName('queue')
  .setDescription('Show the current track and up to ten upcoming tracks.');

export function createQueueCommand(playback: PlaybackManager): Command {
  return {
    definition: queueDefinition,
    async execute(interaction) {
      if (!interaction.inCachedGuild()) {
        await interaction.reply({
          content: 'This command can only be used in a Discord server.',
          flags: MessageFlags.Ephemeral,
        });
        return commandRejected('guild_only');
      }

      const snapshot = playback.snapshot(interaction.guildId);
      if (!snapshot.current && snapshot.upcoming.length === 0) {
        await interaction.reply({ content: 'The playback queue is empty.' });
        return commandSucceeded('empty', { upcomingCount: 0 });
      }

      const browseRow = buildQueueBrowseRow(snapshot);
      await interaction.reply({
        embeds: [buildQueueEmbed(snapshot)],
        ...(browseRow ? { components: [browseRow] } : {}),
      });
      return commandSucceeded('shown', {
        currentTrackId: snapshot.current?.id,
        upcomingCount: snapshot.upcoming.length,
      });
    },
  };
}

export async function handleQueueButton(
  interaction: ButtonInteraction,
  playback: PlaybackManager,
  logger: Pick<Logger, 'error'>,
): Promise<boolean> {
  const page = parseQueuePageCustomId(interaction.customId);
  const browsing = interaction.customId === QUEUE_BROWSE_CUSTOM_ID;
  if (!browsing && page === undefined) return false;

  try {
    if (!interaction.inCachedGuild()) {
      await interaction.reply({
        content: 'This control can only be used in a Discord server.',
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    const snapshot = playback.snapshot(interaction.guildId);
    if (isQueueEmpty(snapshot)) {
      if (browsing) {
        await interaction.reply({
          content: 'The playback queue is empty.',
          flags: MessageFlags.Ephemeral,
        });
      } else {
        await interaction.update({
          content: 'The playback queue is empty.',
          embeds: [],
          components: [],
        });
      }
      return true;
    }

    const targetPage = browsing ? 2 : page!;
    const paginationRow = buildQueuePaginationRow(snapshot, targetPage);
    const response = {
      embeds: [buildQueuePageEmbed(snapshot, targetPage)],
      components: paginationRow ? [paginationRow] : [],
    };

    if (browsing) {
      await interaction.reply({
        ...response,
        flags: MessageFlags.Ephemeral,
      });
    } else {
      await interaction.update(response);
    }
  } catch (error) {
    logger.error('queue_component_error', error, {
      interactionId: interaction.id,
      customId: interaction.customId,
      userId: interaction.user.id,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
    });
    const response = {
      content:
        'The queue view could not be updated. Please run `/queue` again.',
      flags: MessageFlags.Ephemeral,
    } as const;
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(response).catch(() => undefined);
    } else {
      await interaction.reply(response).catch(() => undefined);
    }
  }

  return true;
}

export function buildQueueBrowseRow(
  snapshot: QueueSnapshot,
): ActionRowBuilder<ButtonBuilder> | undefined {
  if (snapshot.upcoming.length <= QUEUE_PAGE_SIZE) return undefined;
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(QUEUE_BROWSE_CUSTOM_ID)
      .setLabel('Browse full queue')
      .setStyle(ButtonStyle.Primary),
  );
}

export function buildQueuePaginationRow(
  snapshot: QueueSnapshot,
  page: number,
): ActionRowBuilder<ButtonBuilder> | undefined {
  const totalPages = queuePageCount(snapshot);
  const vanished = page > totalPages;
  if (!vanished && totalPages === 1) return undefined;

  const previousPage = vanished ? totalPages : Math.max(1, page - 1);
  const nextPage = Math.min(totalPages, page + 1);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    navigationButton('first', 1, '⏮️', page <= 1),
    navigationButton('previous', previousPage, '◀️', page <= 1),
    navigationButton('next', nextPage, '▶️', vanished || page >= totalPages),
    navigationButton('last', totalPages, '⏭️', vanished || page >= totalPages),
  );
}

export function queuePageCustomId(
  action: QueuePageAction,
  page: number,
): string {
  return `queue:v1:page:${action}:${page}`;
}

function navigationButton(
  action: QueuePageAction,
  page: number,
  emoji: string,
  disabled: boolean,
): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(queuePageCustomId(action, page))
    .setEmoji(emoji)
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(disabled);
}

function parseQueuePageCustomId(customId: string): number | undefined {
  const match = QUEUE_PAGE_CUSTOM_ID.exec(customId);
  if (!match) return undefined;
  const page = Number(match[2]);
  return Number.isSafeInteger(page) && page > 0 ? page : undefined;
}

function isQueueEmpty(snapshot: QueueSnapshot): boolean {
  return !snapshot.current && snapshot.upcoming.length === 0;
}
