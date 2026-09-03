import assert from 'node:assert/strict';
import type { ChatInputCommandInteraction } from 'discord.js';
import { test } from 'vitest';
import {
  commandLogContext,
  logCommandReceived,
  logCommandResult,
} from '../src/command-logging.js';
import {
  commandFailed,
  commandRejected,
  commandSucceeded,
} from '../src/commands/command.js';
import { JsonLogger } from '../src/logger.js';

test('command logs contain shallow raw options without Discord interaction data', () => {
  const interaction = {
    id: 'interaction-1',
    commandName: 'play-test',
    token: 'never-log-this-token',
    user: { id: 'user-1', tag: 'listener' },
    guildId: 'guild-1',
    channelId: 'channel-1',
    options: {
      data: [
        { name: 'query', type: 3, value: 'raw search words' },
        { name: 'count', type: 4, value: 2 },
      ],
    },
  } as unknown as ChatInputCommandInteraction;

  const context = commandLogContext(interaction);

  assert.deepEqual(context, {
    interactionId: 'interaction-1',
    command: 'play-test',
    userId: 'user-1',
    userTag: 'listener',
    guildId: 'guild-1',
    channelId: 'channel-1',
    options: { query: 'raw search words', count: 2 },
  });
  const serialized = JSON.stringify(context);
  assert.equal(serialized.includes('never-log-this-token'), false);
  assert.equal(serialized.includes('"token"'), false);
});

test('command received and result records are correlated and routed by outcome', () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const logger = new JsonLogger(
    { write: (value) => stdout.push(value) },
    { write: (value) => stderr.push(value) },
  );
  const context = {
    interactionId: 'interaction-1',
    command: 'play-test',
    userId: 'user-1',
    userTag: 'listener',
    guildId: 'guild-1',
    channelId: 'channel-1',
    options: { query: 'raw search words' },
  } as const;

  logCommandReceived(logger, context);
  logCommandResult(
    logger,
    context,
    commandSucceeded('queued', { trackId: 'video-1', queuePosition: 2 }),
    12.6,
  );
  logCommandResult(
    logger,
    context,
    commandRejected('different_voice_channel'),
    2,
  );
  logCommandResult(
    logger,
    context,
    commandFailed(new Error('command exploded')),
    4,
  );

  assert.equal(stdout.length, 3);
  assert.equal(stderr.length, 1);
  for (const line of [...stdout, ...stderr]) {
    assert.equal(line.endsWith('\n'), true);
    assert.equal(line.slice(0, -1).includes('\n'), false);
    assert.doesNotThrow(() => JSON.parse(line));
  }

  const [received, success, rejected] = stdout.map((line) => JSON.parse(line));
  const failure = JSON.parse(stderr[0] ?? '{}');
  assert.equal(received.event, 'command_received');
  assert.equal(received.interactionId, 'interaction-1');
  assert.equal(success.event, 'command_result');
  assert.equal(success.interactionId, received.interactionId);
  assert.equal(success.outcome, 'success');
  assert.equal(success.result, 'queued');
  assert.equal(success.durationMs, 13);
  assert.deepEqual(success.details, {
    trackId: 'video-1',
    queuePosition: 2,
  });
  assert.equal(rejected.level, 'info');
  assert.equal(rejected.outcome, 'rejected');
  assert.equal(failure.level, 'error');
  assert.equal(failure.outcome, 'error');
  assert.equal(failure.result, 'unexpected_error');
  assert.equal(failure.error.name, 'Error');
  assert.equal(failure.error.message, 'command exploded');
});
