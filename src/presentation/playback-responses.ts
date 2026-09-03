import { EmbedBuilder } from 'discord.js';
import type { Track } from '../media.js';
import type {
  EnqueuePlacement,
  QueueSnapshot,
  RemoveResult,
  SkipResult,
  StopResult,
} from '../playback-manager.js';
import {
  escapeMarkdown,
  formatDuration,
  linkedTrack,
  truncate,
} from './discord-format.js';

export const QUEUE_PAGE_SIZE = 10;

export function buildPlayAcknowledgement(
  track: Track,
  started: boolean,
  position: number,
  placement: EnqueuePlacement = 'back',
): EmbedBuilder {
  const status = started
    ? '▶️ Now playing'
    : placement === 'front'
      ? '⏭️ Playing next'
      : '➕ Added to queue';
  const embed = new EmbedBuilder()
    .setColor(started ? 0x57f287 : 0xfee75c)
    .setAuthor({ name: status })
    .setTitle(truncate(track.title, 256))
    .setURL(track.webpageUrl)
    .setDescription(`[Open on YouTube](${track.webpageUrl})`)
    .addFields({
      name: 'Duration',
      value: formatDuration(track.durationSeconds),
      inline: true,
    })
    .setFooter({
      text: `Requested by ${truncate(track.requestedBy.displayName, 180)}`,
    });
  if (!started) {
    embed.addFields({
      name: 'Queue position',
      value: String(position),
      inline: true,
    });
  }
  if (track.thumbnailUrl) embed.setThumbnail(track.thumbnailUrl);
  return embed;
}

export function buildQueueEmbed(snapshot: QueueSnapshot): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(0xff0000)
    .setTitle('Playback queue');
  const sections: string[] = [];

  if (snapshot.current) {
    sections.push(`**Now playing**\n${trackLine(snapshot.current)}`);
    if (snapshot.current.thumbnailUrl)
      embed.setThumbnail(snapshot.current.thumbnailUrl);
  }

  if (snapshot.upcoming.length > 0) {
    const visible = snapshot.upcoming.slice(0, QUEUE_PAGE_SIZE);
    const lines = visible.map(
      (track, index) => `${index + 1}. ${trackLine(track)}`,
    );
    if (snapshot.upcoming.length > visible.length) {
      lines.push(`…and ${snapshot.upcoming.length - visible.length} more.`);
    }
    sections.push(`**Up next**\n${lines.join('\n')}`);
    sections.push(
      'Use `/remove tracks:12` or `/remove tracks:12-20` to remove upcoming tracks.',
    );
  }

  if (sections.length > 0) embed.setDescription(sections.join('\n\n'));

  return embed.setFooter({
    text: `${snapshot.upcoming.length} upcoming track${snapshot.upcoming.length === 1 ? '' : 's'}`,
  });
}

export function queuePageCount(snapshot: QueueSnapshot): number {
  return Math.max(1, Math.ceil(snapshot.upcoming.length / QUEUE_PAGE_SIZE));
}

export function buildQueuePageEmbed(
  snapshot: QueueSnapshot,
  page: number,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(0xff0000)
    .setTitle('Playback queue');
  const sections: string[] = [];
  const totalPages = queuePageCount(snapshot);
  const vanished = page > totalPages;
  const startIndex = (page - 1) * QUEUE_PAGE_SIZE;
  const visible = snapshot.upcoming.slice(
    startIndex,
    startIndex + QUEUE_PAGE_SIZE,
  );

  if (snapshot.current) {
    sections.push(`**Now playing**\n${trackLine(snapshot.current)}`);
    if (snapshot.current.thumbnailUrl)
      embed.setThumbnail(snapshot.current.thumbnailUrl);
  }

  if (visible.length > 0) {
    const lines = visible.map(
      (track, index) => `${startIndex + index + 1}. ${trackLine(track)}`,
    );
    sections.push(`**Up next**\n${lines.join('\n')}`);
  } else if (vanished) {
    sections.push(`**Up next**\nNo upcoming tracks remain on page ${page}.`);
  }

  if (sections.length > 0) embed.setDescription(sections.join('\n\n'));

  const trackCount = `${snapshot.upcoming.length} upcoming track${snapshot.upcoming.length === 1 ? '' : 's'}`;
  return embed.setFooter({
    text: vanished
      ? `Page ${page} is empty • Queue currently ends on page ${totalPages} • ${trackCount}`
      : `Page ${page} of ${totalPages} • ${trackCount}`,
  });
}

export function playlistMessage(
  trackCount: number,
  started: boolean,
  position: number,
  playlistUrl: string,
): string {
  const tracks = `${trackCount} track${trackCount === 1 ? '' : 's'}`;
  return started
    ? `▶️ Started a playlist with **${tracks}**: ${playlistUrl}`
    : `➕ Added **${tracks}** to the queue, starting at position **${position}**: ${playlistUrl}`;
}

export function pauseMessage(snapshot: QueueSnapshot): string {
  return `⏸️ Paused ${linkedTrack(snapshot.current!)}.`;
}

export function resumeMessage(snapshot: QueueSnapshot): string {
  return `▶️ Resumed ${linkedTrack(snapshot.current!)}.`;
}

export function skipMessage(result: SkipResult): string {
  return result.startedNext && result.snapshot.current
    ? `⏭️ Skipped to **${escapeMarkdown(result.snapshot.current.title)}**.`
    : `⏹️ Stopped **${escapeMarkdown(result.skipped.title)}** because the queue is empty.`;
}

export function removeMessage({
  removed,
  startPosition,
  endPosition,
}: RemoveResult): string {
  if (removed.length === 1) {
    return `🗑️ Removed ${linkedTrack(removed[0]!)} from the queue.`;
  }
  return `🗑️ Removed **${removed.length} tracks** (positions **${startPosition}–${endPosition}**) from the queue.`;
}

export function stopMessage({ removedUpcoming }: StopResult): string {
  return `⏹️ Playback stopped and ${removedUpcoming} queued track${removedUpcoming === 1 ? '' : 's'} cleared.`;
}

export function disconnectMessage(): string {
  return '👋 Playback cleared and voice disconnected.';
}

export function idleDisconnectMessage(): string {
  return '👋 Playback has been idle, so I disconnected from voice.';
}

function trackLine(track: Track): string {
  const trackLink = linkedTrack({
    title: truncate(track.title, 70),
    webpageUrl: track.webpageUrl,
  });
  return `${trackLink} • ${formatDuration(track.durationSeconds)} • ${escapeMarkdown(truncate(track.requestedBy.displayName, 40))}`;
}
