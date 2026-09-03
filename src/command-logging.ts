import type { ChatInputCommandInteraction } from 'discord.js';
import type { CommandExecutionResult } from './commands/command.js';
import type { LogContext, Logger } from './logger.js';

export type CommandLogContext = LogContext & {
  readonly interactionId: string;
  readonly command: string;
  readonly userId: string;
  readonly userTag: string;
  readonly guildId: string | null;
  readonly channelId: string;
  readonly options: Readonly<Record<string, unknown>>;
};

export function commandLogContext(
  interaction: ChatInputCommandInteraction,
): CommandLogContext {
  const options: Record<string, unknown> = {};
  for (const option of interaction.options.data) {
    if (option.value !== undefined) options[option.name] = option.value;
  }

  return {
    interactionId: interaction.id,
    command: interaction.commandName,
    userId: interaction.user.id,
    userTag: interaction.user.tag,
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    options,
  };
}

export function logCommandReceived(
  logger: Logger,
  context: CommandLogContext,
): void {
  logger.info('command_received', context);
}

export function logCommandResult(
  logger: Logger,
  context: CommandLogContext,
  result: CommandExecutionResult,
  durationMs: number,
): void {
  const resultContext: LogContext = {
    ...context,
    outcome: result.outcome,
    result: result.result,
    durationMs: Math.max(0, Math.round(durationMs)),
    ...(result.details ? { details: result.details } : {}),
  };
  if (result.outcome === 'error') {
    logger.error('command_result', result.error, resultContext);
  } else {
    logger.info('command_result', resultContext);
  }
}
