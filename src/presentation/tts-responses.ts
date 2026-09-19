import { escapeMarkdown, truncate } from './discord-format.js';

const PREVIEW_LENGTH = 80;

export function speakingMessage(text: string, voiceLabel: string): string {
  const voiceName = voiceLabel.replace(/ \([^,]+, [^)]+\)$/u, '');
  return `🔊 **${escapeMarkdown(voiceName)}**: ${escapeMarkdown(truncate(text, PREVIEW_LENGTH))}`;
}

export function speechQueuedMessage(position: number): string {
  return `Queued to speak (position ${position}).`;
}

export function voiceSelectedMessage(voiceLabel: string): string {
  return `Your voice is now **${escapeMarkdown(voiceLabel)}**.`;
}

export function speechCancelledMessage(): string {
  return 'That message was cancelled before it could be spoken.';
}

export function speechFailedMessage(reason: string): string {
  return `Could not speak that message. ${reason}`;
}

export function droppedUtterancesMessage(count: number): string {
  return `Music is starting, so ${count} queued message${count === 1 ? ' was' : 's were'} dropped.`;
}

export function musicActiveMessage(): string {
  return 'Cannot speak while music is loaded. Use `/stop` first.';
}
