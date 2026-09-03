import type {
  ChatInputCommandInteraction,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';

export type CommandDefinition = {
  readonly name: string;
  toJSON(): RESTPostAPIChatInputApplicationCommandsJSONBody;
};

export type CommandResultDetails = Readonly<Record<string, unknown>>;

export type CommandSuccessCode =
  | 'started'
  | 'queued'
  | 'paused'
  | 'resumed'
  | 'advanced'
  | 'stopped'
  | 'removed'
  | 'disconnected'
  | 'shown'
  | 'empty';

export type CommandRejectionCode =
  | 'guild_only'
  | 'not_in_voice'
  | 'bot_not_connected'
  | 'different_voice_channel'
  | 'unsupported_input'
  | 'media_rejected'
  | 'playback_rejected';

export type CommandExecutionResult =
  | {
      outcome: 'success';
      result: CommandSuccessCode;
      details?: CommandResultDetails;
    }
  | {
      outcome: 'rejected';
      result: CommandRejectionCode;
      details?: CommandResultDetails;
    }
  | {
      outcome: 'error';
      result: 'unexpected_error';
      error: unknown;
      details?: CommandResultDetails;
    };

export interface Command {
  readonly definition: CommandDefinition;
  execute(
    interaction: ChatInputCommandInteraction,
  ): Promise<CommandExecutionResult>;
}

export function commandSucceeded(
  result: CommandSuccessCode,
  details?: CommandResultDetails,
): CommandExecutionResult {
  return { outcome: 'success', result, ...(details ? { details } : {}) };
}

export function commandRejected(
  result: CommandRejectionCode,
): CommandExecutionResult {
  return { outcome: 'rejected', result };
}

export function commandFailed(
  error: unknown,
  details?: CommandResultDetails,
): CommandExecutionResult {
  return {
    outcome: 'error',
    result: 'unexpected_error',
    error,
    ...(details ? { details } : {}),
  };
}
