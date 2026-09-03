import { escapeMarkdown as escapeDiscordMarkdown, hyperlink } from 'discord.js';
import type { Track } from '../media.js';

export function escapeMarkdown(value: string): string {
  return escapeDiscordMarkdown(value);
}

export function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

export function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = Math.floor(seconds % 60);
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${minutes}:${String(remainder).padStart(2, '0')}`;
}

export function linkedTrack(
  track: Pick<Track, 'title' | 'webpageUrl'>,
): string {
  return hyperlink(track.title, track.webpageUrl);
}
