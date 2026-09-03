export type LogContext = Readonly<Record<string, unknown>>;

export interface Logger {
  info(event: string, context?: LogContext): void;
  error(event: string, error?: unknown, context?: LogContext): void;
}

type LogSink = {
  write(value: string): unknown;
};

export class JsonLogger implements Logger {
  constructor(
    private readonly stdout: LogSink = process.stdout,
    private readonly stderr: LogSink = process.stderr,
  ) {}

  info(event: string, context: LogContext = {}): void {
    // One JSON object per line stays friendly to both terminals and log shippers.
    this.stdout.write(`${JSON.stringify(record('info', event, context))}\n`);
  }

  error(event: string, error?: unknown, context: LogContext = {}): void {
    this.stderr.write(
      `${JSON.stringify(
        record('error', event, {
          ...context,
          ...(error === undefined ? {} : { error: serializeError(error) }),
        }),
      )}\n`,
    );
  }
}

export const logger: Logger = new JsonLogger();

function record(
  level: 'info' | 'error',
  event: string,
  context: LogContext,
): Record<string, unknown> {
  return {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...context,
  };
}

function serializeError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    ...(error.cause === undefined
      ? {}
      : { cause: serializeError(error.cause) }),
  };
}
