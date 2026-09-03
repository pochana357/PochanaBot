import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { ChatInputCommandInteraction } from 'discord.js';
import { test } from 'vitest';
import {
  commandDefinitions,
  commandPayloadsFor,
  createCommandMap,
} from '../src/commands/catalog.js';
import { createDisconnectCommand } from '../src/commands/disconnect.js';
import { createPauseCommand } from '../src/commands/pause.js';
import {
  createPlayCommand,
  createPlayNextCommand,
} from '../src/commands/play.js';
import { createPlaylistCommand } from '../src/commands/playlist.js';
import { createQueueCommand } from '../src/commands/queue.js';
import {
  createRemoveCommand,
  parseTrackSelection,
} from '../src/commands/remove.js';
import { createResumeCommand } from '../src/commands/resume.js';
import { createSkipCommand } from '../src/commands/skip.js';
import { createStopCommand } from '../src/commands/stop.js';
import { executeVoiceControl } from '../src/commands/voice-control.js';
import { commandSucceeded } from '../src/commands/command.js';
import type { MediaProvider, PlaylistProvider, Track } from '../src/media.js';
import type { PlaybackManager } from '../src/playback-manager.js';

type ReplyPayload = {
  content?: string;
  embeds?: Array<{
    toJSON(): {
      author?: { name?: string };
      fields?: Array<{ value?: string }>;
      title?: string;
      url?: string;
    };
  }>;
  flags?: number;
};

type RecordedCall = [name: string, payload?: ReplyPayload];

test('deployment exposes the complete slash-command surface', () => {
  assert.deepEqual(
    commandDefinitions.map((definition) => definition.toJSON().name),
    [
      'play',
      'play-next',
      'playlist',
      'pause',
      'resume',
      'skip',
      'remove',
      'stop',
      'disconnect',
      'queue',
    ],
  );
});

test('/remove parses one position or an inclusive position range', () => {
  assert.deepEqual(parseTrackSelection('12'), { start: 12, end: 12 });
  assert.deepEqual(parseTrackSelection('12-20'), { start: 12, end: 20 });
  assert.deepEqual(parseTrackSelection(' 12 - 20 '), { start: 12, end: 20 });
  for (const invalid of ['0', '12-', '20-12', 'track 12']) {
    assert.throws(() => parseTrackSelection(invalid), /12.*12-20/);
  }
});

test('test deployment names and descriptions are visibly marked', () => {
  const globalPayloads = commandPayloadsFor('global');
  const testPayloads = commandPayloadsFor('test');

  assert.deepEqual(
    testPayloads.map((payload) => payload.name),
    globalPayloads.map((payload) => `${payload.name}-test`),
  );
  assert.deepEqual(
    testPayloads.map((payload) => payload.description),
    globalPayloads.map((payload) => `[TEST] ${payload.description}`),
  );
});

test('command routing maps every definition to its implementation', () => {
  const provider: MediaProvider & PlaylistProvider = {
    supports: () => true,
    resolve: async () => [],
    resolvePlaylist: async () => [],
    createPlaybackStream: async () => Readable.from([]),
  };
  const playback = {} as PlaybackManager;
  const commands = createCommandMap(provider, playback);
  const productionNames = commandDefinitions.map(
    (definition) => definition.name,
  );

  assert.deepEqual(
    [...commands.keys()],
    productionNames.flatMap((name) => [name, `${name}-test`]),
  );
  for (const command of commands.values())
    assert.equal(typeof command.execute, 'function');
  for (const name of productionNames)
    assert.equal(commands.get(`${name}-test`), commands.get(name));
});

test('/play defers metadata resolution and publishes the resolved track', async () => {
  const calls: RecordedCall[] = [];
  const track: Track = {
    provider: 'youtube',
    id: 'video-1',
    title: 'Resolved YouTube title',
    webpageUrl: 'https://www.youtube.com/watch?v=video-1',
    durationSeconds: 42,
    requestedBy: { id: 'user-1', displayName: 'Listener' },
  };
  const provider: MediaProvider = {
    supports: () => true,
    resolve: async () => [track],
    createPlaybackStream: async () => Readable.from([]),
  };
  const playback = {
    channelId: () => undefined,
    enqueue: async () => ({
      started: false,
      position: 1,
      snapshot: { current: track, upcoming: [track] },
    }),
  } as unknown as PlaybackManager;
  const interaction = {
    commandName: 'play',
    guildId: 'guild-1',
    guild: { voiceAdapterCreator: {} },
    member: { displayName: 'Listener', voice: { channel: { id: 'voice-1' } } },
    user: { id: 'user-1' },
    channel: {
      isTextBased: () => true,
      send: async (payload: ReplyPayload) => calls.push(['send', payload]),
    },
    options: { getString: () => 'a search query' },
    inCachedGuild: () => true,
    deferReply: async (payload: ReplyPayload) => calls.push(['defer', payload]),
    followUp: async (payload: ReplyPayload) =>
      calls.push(['followUp', payload]),
    deleteReply: async () => calls.push(['delete']),
    editReply: async (payload: ReplyPayload) => calls.push(['edit', payload]),
  } as unknown as ChatInputCommandInteraction;

  const result = await createPlayCommand(provider, playback).execute(
    interaction,
  );

  assert.deepEqual(
    calls.map(([name]) => name),
    ['defer', 'send', 'delete'],
  );
  assert.equal(calls[0]?.[1]?.flags, 64);
  const acknowledgement = calls[1]?.[1]?.embeds?.[0]?.toJSON();
  assert.ok(acknowledgement);
  assert.equal(acknowledgement.author?.name, '➕ Added to queue');
  assert.equal(acknowledgement.title, track.title);
  assert.equal(acknowledgement.url, track.webpageUrl);
  assert.equal(acknowledgement.fields?.[1]?.value, '1');
  assert.deepEqual(result, {
    outcome: 'success',
    result: 'queued',
    details: { trackId: track.id, queuePosition: 1 },
  });
});

test('/play-next uses front placement and identifies the track as playing next', async () => {
  const calls: RecordedCall[] = [];
  const track: Track = {
    provider: 'youtube',
    id: 'video-next',
    title: 'Priority track',
    webpageUrl: 'https://www.youtube.com/watch?v=video-next',
    durationSeconds: 42,
    requestedBy: { id: 'user-1', displayName: 'Listener' },
  };
  const provider: MediaProvider = {
    supports: () => true,
    resolve: async () => [track],
    createPlaybackStream: async () => Readable.from([]),
  };
  let placement: string | undefined;
  const playback = {
    channelId: () => 'voice-1',
    enqueue: async (
      _context: unknown,
      _tracks: readonly Track[],
      options: { placement?: string },
    ) => {
      placement = options.placement;
      return {
        started: false,
        position: 1,
        snapshot: { current: track, upcoming: [track] },
      };
    },
  } as unknown as PlaybackManager;
  const interaction = {
    commandName: 'play-next',
    guildId: 'guild-1',
    guild: { voiceAdapterCreator: {} },
    member: { displayName: 'Listener', voice: { channel: { id: 'voice-1' } } },
    user: { id: 'user-1' },
    channel: {
      isTextBased: () => true,
      send: async (payload: ReplyPayload) => calls.push(['send', payload]),
    },
    options: { getString: () => 'a priority search' },
    inCachedGuild: () => true,
    deferReply: async (payload: ReplyPayload) => calls.push(['defer', payload]),
    deleteReply: async () => calls.push(['delete']),
    editReply: async (payload: ReplyPayload) => calls.push(['edit', payload]),
  } as unknown as ChatInputCommandInteraction;

  const result = await createPlayNextCommand(provider, playback).execute(
    interaction,
  );

  assert.equal(placement, 'front');
  assert.deepEqual(
    calls.map(([name]) => name),
    ['defer', 'send', 'delete'],
  );
  const acknowledgement = calls[1]?.[1]?.embeds?.[0]?.toJSON();
  assert.ok(acknowledgement);
  assert.equal(acknowledgement.author?.name, '⏭️ Playing next');
  assert.equal(acknowledgement.title, track.title);
  assert.equal(acknowledgement.url, track.webpageUrl);
  assert.equal(acknowledgement.fields?.[1]?.value, '1');
  assert.deepEqual(result, {
    outcome: 'success',
    result: 'queued',
    details: { trackId: track.id, queuePosition: 1 },
  });
});

test('/playlist resolves and enqueues every track in one ordered operation', async () => {
  const calls: RecordedCall[] = [];
  const playlistUrl = 'https://youtube.com/playlist?list=PL123';
  const tracks: Track[] = [
    {
      provider: 'youtube',
      id: 'aaaaaaaaaaa',
      title: 'First track',
      webpageUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
      durationSeconds: 187,
      requestedBy: { id: 'user-1', displayName: 'Listener' },
    },
    {
      provider: 'youtube',
      id: 'bbbbbbbbbbb',
      title: 'Second track',
      webpageUrl: 'https://www.youtube.com/watch?v=bbbbbbbbbbb',
      durationSeconds: 213,
      requestedBy: { id: 'user-1', displayName: 'Listener' },
    },
  ];
  const provider: PlaylistProvider = {
    resolvePlaylist: async () => tracks,
  };
  let enqueued: readonly Track[] | undefined;
  const playback = {
    channelId: () => undefined,
    enqueue: async (_context: unknown, items: readonly Track[]) => {
      enqueued = items;
      return {
        started: false,
        position: 3,
        snapshot: { current: tracks[0], upcoming: tracks },
      };
    },
  } as unknown as PlaybackManager;
  const interaction = {
    commandName: 'playlist',
    guildId: 'guild-1',
    guild: { voiceAdapterCreator: {} },
    member: { displayName: 'Listener', voice: { channel: { id: 'voice-1' } } },
    user: { id: 'user-1' },
    channel: {
      isTextBased: () => true,
      send: async (payload: ReplyPayload) => calls.push(['send', payload]),
    },
    options: { getString: () => playlistUrl },
    inCachedGuild: () => true,
    deferReply: async (payload: ReplyPayload) => calls.push(['defer', payload]),
    deleteReply: async () => calls.push(['delete']),
    editReply: async (payload: ReplyPayload) => calls.push(['edit', payload]),
  } as unknown as ChatInputCommandInteraction;

  const result = await createPlaylistCommand(provider, playback).execute(
    interaction,
  );

  assert.equal(enqueued, tracks);
  assert.deepEqual(
    calls.map(([name]) => name),
    ['defer', 'send', 'delete'],
  );
  assert.equal(calls[0]?.[1]?.flags, 64);
  assert.equal(
    calls[1]?.[1]?.content,
    `➕ Added **2 tracks** to the queue, starting at position **3**: ${playlistUrl}`,
  );
  assert.deepEqual(result, {
    outcome: 'success',
    result: 'queued',
    details: { trackCount: 2, queuePosition: 3 },
  });
});

test('voice controls require the caller to share the bot voice channel', async () => {
  const replies: ReplyPayload[] = [];
  let actionCalls = 0;
  const interaction = {
    commandName: 'pause',
    guildId: 'guild-1',
    member: { voice: { channel: { id: 'voice-other' } } },
    inCachedGuild: () => true,
    reply: async (payload: ReplyPayload) => replies.push(payload),
  } as unknown as ChatInputCommandInteraction;
  const playback = {
    channelId: () => 'voice-bot',
  } as unknown as PlaybackManager;

  const result = await executeVoiceControl(
    interaction,
    playback,
    async () => {
      actionCalls += 1;
    },
    () => 'done',
    () => commandSucceeded('paused'),
  );

  assert.equal(actionCalls, 0);
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.flags, 64);
  assert.match(
    replies[0]?.content ?? '',
    /voice channel that the bot is already using/i,
  );
  assert.deepEqual(result, {
    outcome: 'rejected',
    result: 'different_voice_channel',
  });
});

test('voice controls return public success acknowledgements', async () => {
  const replies: ReplyPayload[] = [];
  const interaction = {
    commandName: 'pause',
    guildId: 'guild-1',
    member: { voice: { channel: { id: 'voice-bot' } } },
    inCachedGuild: () => true,
    reply: async (payload: ReplyPayload) => replies.push(payload),
  } as unknown as ChatInputCommandInteraction;
  const playback = {
    channelId: () => 'voice-bot',
  } as unknown as PlaybackManager;

  const result = await executeVoiceControl(
    interaction,
    playback,
    async (guildId) => guildId,
    (guildId) => `controlled ${guildId}`,
    () => commandSucceeded('paused'),
  );

  assert.deepEqual(replies, [{ content: 'controlled guild-1' }]);
  assert.deepEqual(result, {
    outcome: 'success',
    result: 'paused',
  });
});

test('voice command wrappers return their compact success results', async () => {
  const current = {
    provider: 'youtube',
    id: 'aaaaaaaaaaa',
    title: 'Current track',
    webpageUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
    durationSeconds: 60,
    requestedBy: { id: 'user-1', displayName: 'Listener' },
  } satisfies Track;
  const upcoming = { ...current, id: 'bbbbbbbbbbb', title: 'Upcoming track' };
  const snapshot = { current, upcoming: [upcoming] };
  const playback = {
    channelId: () => 'voice-bot',
    pause: async () => snapshot,
    resume: async () => snapshot,
    remove: async () => ({ removed: [upcoming], snapshot }),
    stop: async () => ({ stopped: current, removedUpcoming: 1 }),
    disconnect: async () => snapshot,
  } as unknown as PlaybackManager;
  const commands = [
    ['pause', createPauseCommand(playback), commandSucceeded('paused')],
    ['resume', createResumeCommand(playback), commandSucceeded('resumed')],
    [
      'remove',
      createRemoveCommand(playback),
      commandSucceeded('removed', { removedCount: 1 }),
    ],
    [
      'stop',
      createStopCommand(playback),
      commandSucceeded('stopped', { clearedCount: 2 }),
    ],
    [
      'disconnect',
      createDisconnectCommand(playback),
      commandSucceeded('disconnected'),
    ],
  ] as const;

  for (const [commandName, command, expected] of commands) {
    const interaction = {
      commandName,
      guildId: 'guild-1',
      member: { voice: { channel: { id: 'voice-bot' } } },
      options: { getString: () => '1' },
      inCachedGuild: () => true,
      reply: async () => undefined,
    } as unknown as ChatInputCommandInteraction;

    assert.deepEqual(await command.execute(interaction), expected);
  }
});

test('voice controls return unexpected failures for central error logging', async () => {
  const failure = new Error('control exploded');
  const interaction = {
    commandName: 'pause',
    guildId: 'guild-1',
    member: { voice: { channel: { id: 'voice-bot' } } },
    inCachedGuild: () => true,
    reply: async () => undefined,
  } as unknown as ChatInputCommandInteraction;
  const playback = {
    channelId: () => 'voice-bot',
  } as unknown as PlaybackManager;

  const result = await executeVoiceControl(
    interaction,
    playback,
    async () => {
      throw failure;
    },
    () => 'not reached',
    () => commandSucceeded('paused'),
  );

  assert.equal(result.outcome, 'error');
  assert.equal(result.result, 'unexpected_error');
  if (result.outcome === 'error') assert.equal(result.error, failure);
});

test('/skip reports whether playback advanced', async () => {
  const replies: RecordedCall[] = [];
  const current = {
    provider: 'youtube',
    id: 'aaaaaaaaaaa',
    title: 'Current track',
    webpageUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
    durationSeconds: 60,
    requestedBy: { id: 'user-1', displayName: 'Listener' },
  } satisfies Track;
  const next = { ...current, id: 'bbbbbbbbbbb', title: 'Next track' };
  const playback = {
    channelId: () => 'voice-bot',
    skip: async () => ({
      skipped: current,
      startedNext: true,
      snapshot: { current: next, upcoming: [] },
    }),
  } as unknown as PlaybackManager;
  const interaction = {
    commandName: 'skip',
    guildId: 'guild-1',
    member: { voice: { channel: { id: 'voice-bot' } } },
    channel: {
      isTextBased: () => true,
      send: async (payload: ReplyPayload) => replies.push(['send', payload]),
    },
    inCachedGuild: () => true,
    deferReply: async (payload: ReplyPayload) =>
      replies.push(['defer', payload]),
    deleteReply: async () => replies.push(['delete']),
  } as unknown as ChatInputCommandInteraction;

  const result = await createSkipCommand(playback).execute(interaction);

  assert.equal(result.outcome, 'success');
  assert.equal(result.result, 'advanced');
  assert.equal(result.details, undefined);
  assert.deepEqual(
    replies.map(([name]) => name),
    ['defer', 'send', 'delete'],
  );
});

test('/queue returns a compact empty result', async () => {
  const replies: ReplyPayload[] = [];
  const playback = {
    snapshot: () => ({ upcoming: [] }),
  } as unknown as PlaybackManager;
  const interaction = {
    guildId: 'guild-1',
    inCachedGuild: () => true,
    reply: async (payload: ReplyPayload) => replies.push(payload),
  } as unknown as ChatInputCommandInteraction;

  const result = await createQueueCommand(playback).execute(interaction);

  assert.deepEqual(result, {
    outcome: 'success',
    result: 'empty',
    details: { upcomingCount: 0 },
  });
  assert.deepEqual(replies, [{ content: 'The playback queue is empty.' }]);
});
