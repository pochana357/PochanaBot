import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { DiscordGatewayAdapterCreator } from '@discordjs/voice';
import { test } from 'vitest';
import type { MediaProvider, Track } from '../src/media.js';
import {
  PlaybackManager,
  PlaybackRequestError,
  type PlaybackManagerOptions,
  type VoiceRequestContext,
} from '../src/playback-manager.js';
import type {
  PlaybackController,
  PlaybackControllerState,
  PlaybackEvents,
  PlaybackPipeline,
  PlaybackRuntime,
  VoiceConnectionRequest,
} from '../src/playback-runtime.js';

function track(id: string): Track {
  return {
    provider: 'youtube',
    id: id.padEnd(11, '_').slice(0, 11),
    title: `Track ${id}`,
    webpageUrl: `https://www.youtube.com/watch?v=${id.padEnd(11, '_').slice(0, 11)}`,
    durationSeconds: 60,
    requestedBy: { id: 'user', displayName: 'Tester' },
  };
}

function context(
  guildId = 'guild-1',
  notifications: string[] = [],
): VoiceRequestContext {
  return {
    guildId,
    voiceChannelId: `voice-${guildId}`,
    adapterCreator: {} as DiscordGatewayAdapterCreator,
    notify: async (message) => notifications.push(message),
  };
}

class FakeProvider implements MediaProvider {
  readonly started: string[] = [];
  readonly signals: AbortSignal[] = [];
  readonly failOnStart = new Set<string>();

  supports(): boolean {
    return true;
  }
  async resolve(): Promise<readonly Track[]> {
    return [];
  }

  async createPlaybackStream(
    value: Track,
    signal: AbortSignal,
  ): Promise<Readable> {
    this.started.push(value.title);
    this.signals.push(signal);
    if (this.failOnStart.has(value.title)) throw new Error('provider failure');
    return Readable.from(Buffer.from(value.id));
  }
}

type FakeSession = {
  request: VoiceConnectionRequest;
  events: PlaybackEvents;
  generation: number;
  destroyed: boolean;
  stops: number;
  status: PlaybackControllerState;
};

type PlayRecord = {
  guildId: string;
  title: string;
  generation: number;
};

class FakeRuntime implements PlaybackRuntime {
  readonly sessions = new Map<string, FakeSession>();
  readonly plays: PlayRecord[] = [];
  readonly disposals: string[] = [];
  failConnection = false;

  async connect(
    request: VoiceConnectionRequest,
    events: PlaybackEvents,
  ): Promise<PlaybackController> {
    if (this.failConnection) throw new Error('connection failed');
    const state: FakeSession = {
      request,
      events,
      generation: 0,
      destroyed: false,
      stops: 0,
      status: 'idle',
    };
    this.sessions.set(request.guildId, state);
    return {
      play: (resource: unknown, generation: number) => {
        state.generation = generation;
        state.status = 'playing';
        const { track: value } = resource as { track: Track };
        this.plays.push({
          guildId: request.guildId,
          title: value.title,
          generation,
        });
      },
      state: () => state.status,
      pause: () => {
        if (state.status !== 'playing') return false;
        state.status = 'paused';
        return true;
      },
      resume: () => {
        if (state.status !== 'paused') return false;
        state.status = 'playing';
        return true;
      },
      stop: () => {
        state.stops += 1;
        state.status = 'idle';
      },
      destroy: () => {
        state.destroyed = true;
        state.status = 'idle';
      },
    };
  }

  createPipeline(source: Readable, value: Track): PlaybackPipeline {
    return {
      resource: { track: value },
      dispose: () => {
        source.destroy();
        this.disposals.push(value.title);
      },
    };
  }

  async finish(guildId: string): Promise<void> {
    const session = this.sessions.get(guildId);
    assert.ok(session);
    await session.events.onIdle(session.generation);
  }

  async fail(guildId: string, message = 'player failure'): Promise<void> {
    const session = this.sessions.get(guildId);
    assert.ok(session);
    await session.events.onError(session.generation, new Error(message));
  }

  async loseConnection(guildId: string): Promise<void> {
    const session = this.sessions.get(guildId);
    assert.ok(session);
    await session.events.onConnectionLost(new Error('connection failure'));
  }
}

function createHarness(options: PlaybackManagerOptions = {}) {
  const provider = new FakeProvider();
  const runtime = new FakeRuntime();
  const manager = new PlaybackManager(provider, {
    runtime,
    emptyDisconnectMs: 60_000,
    logger: { error() {} },
    ...options,
  });
  return { manager, provider, runtime, PlaybackRequestError };
}

test('enqueues two tracks and advances in order when the player becomes idle', async () => {
  const { manager, provider, runtime } = await createHarness();
  const first = track('first');
  const second = track('second');

  const firstResult = await manager.enqueue(context(), [first]);
  const secondResult = await manager.enqueue(context(), [second]);

  assert.equal(firstResult.started, true);
  assert.equal(firstResult.position, 1);
  assert.equal(secondResult.started, false);
  assert.equal(secondResult.position, 1);
  assert.equal(manager.snapshot('guild-1').current?.title, first.title);
  assert.deepEqual(
    manager.snapshot('guild-1').upcoming.map((item) => item.title),
    [second.title],
  );

  await runtime.finish('guild-1');

  assert.equal(manager.snapshot('guild-1').current?.title, second.title);
  assert.equal(provider.signals[0]?.aborted, true);
  assert.equal(provider.signals[1]?.aborted, false);
  assert.deepEqual(
    runtime.plays.map(({ title }) => title),
    [first.title, second.title],
  );

  await runtime.finish('guild-1');
  assert.equal(provider.signals[1]?.aborted, true);
  assert.deepEqual(manager.snapshot('guild-1'), {
    current: undefined,
    upcoming: [],
  });
  await manager.shutdown();
});

test('serializes concurrent enqueues without corrupting queue order', async () => {
  const { manager, runtime } = await createHarness();
  const tracks = [track('one'), track('two'), track('three')];

  await Promise.all(tracks.map((item) => manager.enqueue(context(), [item])));
  assert.equal(manager.snapshot('guild-1').current?.title, tracks[0].title);
  assert.deepEqual(
    manager.snapshot('guild-1').upcoming.map((item) => item.title),
    [tracks[1].title, tracks[2].title],
  );

  await runtime.finish('guild-1');
  await runtime.finish('guild-1');
  assert.deepEqual(
    runtime.plays.map(({ title }) => title),
    tracks.map(({ title }) => title),
  );
  await manager.shutdown();
});

test('front insertion plays after the current track and before the existing queue', async () => {
  const { manager, runtime } = await createHarness();
  const current = track('current');
  const queued = track('queued');
  const next = track('next');
  await manager.enqueue(context(), [current]);
  await manager.enqueue(context(), [queued]);

  const result = await manager.enqueue(context(), [next], {
    placement: 'front',
  });

  assert.equal(result.started, false);
  assert.equal(result.position, 1);
  assert.equal(result.snapshot.current?.title, current.title);
  assert.deepEqual(
    result.snapshot.upcoming.map((item) => item.title),
    [next.title, queued.title],
  );

  await runtime.finish('guild-1');
  assert.equal(manager.snapshot('guild-1').current?.title, next.title);
  await manager.shutdown();
});

test('newer front insertions take priority over earlier ones', async () => {
  const { manager } = await createHarness();
  await manager.enqueue(context(), [track('current')]);
  await manager.enqueue(context(), [track('first next')], {
    placement: 'front',
  });
  await manager.enqueue(context(), [track('latest next')], {
    placement: 'front',
  });

  assert.deepEqual(
    manager.snapshot('guild-1').upcoming.map((item) => item.title),
    ['Track latest next', 'Track first next'],
  );
  await manager.shutdown();
});

test('front insertion starts immediately when playback is idle', async () => {
  const { manager } = await createHarness();
  const next = track('next');

  const result = await manager.enqueue(context(), [next], {
    placement: 'front',
  });

  assert.equal(result.started, true);
  assert.equal(result.position, 1);
  assert.equal(result.snapshot.current?.title, next.title);
  assert.deepEqual(result.snapshot.upcoming, []);
  await manager.shutdown();
});

test('rejects additions beyond the configured queue limit', async () => {
  const { manager, PlaybackRequestError } = await createHarness({
    maxQueueLength: 2,
  });
  await manager.enqueue(context(), [track('one')]);
  await manager.enqueue(context(), [track('two')]);

  await assert.rejects(
    manager.enqueue(context(), [track('three')], { placement: 'front' }),
    (error) =>
      error instanceof PlaybackRequestError &&
      /more than 2 tracks/.test(error.message),
  );
  assert.equal(manager.snapshot('guild-1').upcoming.length, 1);
  await manager.shutdown();
});

test('notifies and advances after an active track fails', async () => {
  const notifications: string[] = [];
  const { manager, provider, runtime } = await createHarness();
  const first = track('first');
  const second = track('second');
  const request = context('guild-1', notifications);
  await manager.enqueue(request, [first]);
  await manager.enqueue(request, [second]);

  await runtime.fail('guild-1');

  assert.equal(manager.snapshot('guild-1').current?.title, second.title);
  assert.equal(provider.signals[0]?.aborted, true);
  assert.equal(provider.signals[1]?.aborted, false);
  assert.deepEqual(
    runtime.plays.map(({ title }) => title),
    [first.title, second.title],
  );
  assert.equal(notifications.length, 1);
  assert.match(notifications[0], /Track first/);
  await manager.shutdown();
});

test('skips a track that cannot start and plays the next queued track', async () => {
  const notifications: string[] = [];
  const { manager, provider, runtime } = await createHarness();
  const first = track('first');
  const second = track('second');
  provider.failOnStart.add(first.title);

  const result = await manager.enqueue(context('guild-1', notifications), [
    first,
    second,
  ]);

  assert.equal(result.started, true);
  assert.equal(manager.snapshot('guild-1').current?.title, second.title);
  assert.equal(provider.signals[0]?.aborted, true);
  assert.equal(provider.signals[1]?.aborted, false);
  assert.deepEqual(
    runtime.plays.map(({ title }) => title),
    [second.title],
  );
  assert.equal(notifications.length, 1);
  assert.match(notifications[0], /skipping it/);
  await manager.shutdown();
});

test('keeps guild queues isolated', async () => {
  const { manager, runtime } = await createHarness();
  const first = track('first');
  const second = track('second');

  await Promise.all([
    manager.enqueue(context('guild-a'), [first]),
    manager.enqueue(context('guild-b'), [second]),
  ]);

  assert.equal(manager.snapshot('guild-a').current?.title, first.title);
  assert.equal(manager.snapshot('guild-b').current?.title, second.title);
  assert.equal(runtime.sessions.size, 2);
  await manager.shutdown();
});

test('skip stops the current track and starts the next queued track', async () => {
  const { manager, provider, runtime } = await createHarness();
  const first = track('first');
  const second = track('second');
  await manager.enqueue(context(), [first]);
  await manager.enqueue(context(), [second]);

  const result = await manager.skip('guild-1');

  assert.equal(result.skipped.title, first.title);
  assert.equal(result.startedNext, true);
  assert.equal(result.snapshot.current?.title, second.title);
  assert.equal(provider.signals[0]?.aborted, true);
  assert.equal(provider.signals[1]?.aborted, false);
  assert.equal(runtime.sessions.get('guild-1')?.stops, 1);
  assert.deepEqual(
    runtime.plays.map(({ title }) => title),
    [first.title, second.title],
  );
  await manager.shutdown();
});

test('skip stops playback when there is no next queued track', async () => {
  const { manager, provider, runtime } = await createHarness();
  const first = track('first');
  await manager.enqueue(context(), [first]);

  const result = await manager.skip('guild-1');

  assert.equal(result.skipped.title, first.title);
  assert.equal(result.startedNext, false);
  assert.deepEqual(result.snapshot, { current: undefined, upcoming: [] });
  assert.equal(provider.signals[0]?.aborted, true);
  assert.equal(runtime.sessions.get('guild-1')?.stops, 1);
  await manager.shutdown();
});

test('removes an inclusive range of upcoming tracks without changing playback', async () => {
  const { manager } = await createHarness();
  const tracks = [
    track('first'),
    track('second'),
    track('third'),
    track('fourth'),
    track('fifth'),
  ];
  await manager.enqueue(context(), tracks);

  const result = await manager.remove('guild-1', 2, 3);

  assert.deepEqual(
    result.removed.map(({ title }) => title),
    ['Track third', 'Track fourth'],
  );
  assert.equal(result.startPosition, 2);
  assert.equal(result.endPosition, 3);
  assert.equal(result.snapshot.current?.title, 'Track first');
  assert.deepEqual(
    result.snapshot.upcoming.map(({ title }) => title),
    ['Track second', 'Track fifth'],
  );
  await manager.shutdown();
});

test('clamps a removal range to the last upcoming track', async () => {
  const { manager } = await createHarness();
  await manager.enqueue(
    context(),
    Array.from({ length: 50 }, (_, index) => track(String(index + 1))),
  );

  const result = await manager.remove('guild-1', 3, 50);

  assert.equal(result.removed.length, 47);
  assert.equal(result.removed[0]?.title, 'Track 4');
  assert.equal(result.removed.at(-1)?.title, 'Track 50');
  assert.equal(result.startPosition, 3);
  assert.equal(result.endPosition, 49);
  assert.deepEqual(
    result.snapshot.upcoming.map(({ title }) => title),
    ['Track 2', 'Track 3'],
  );
  await manager.shutdown();
});

test('rejects a removal starting beyond the queue without changing it', async () => {
  const { manager, PlaybackRequestError } = await createHarness();
  await manager.enqueue(context(), [track('first'), track('second')]);
  const before = manager.snapshot('guild-1');

  await assert.rejects(
    manager.remove('guild-1', 2, 50),
    (error) =>
      error instanceof PlaybackRequestError &&
      /only 1 upcoming track/.test(error.message),
  );
  assert.deepEqual(manager.snapshot('guild-1'), before);
  await manager.shutdown();
});

test('skip rejects when nothing is playing', async () => {
  const { manager, PlaybackRequestError } = await createHarness();

  await assert.rejects(
    manager.skip('missing-guild'),
    (error) =>
      error instanceof PlaybackRequestError &&
      /no active track/.test(error.message),
  );
  await manager.shutdown();
});

test('pause and resume enforce playback state transitions', async () => {
  const { manager, runtime, PlaybackRequestError } = await createHarness();
  const first = track('first');
  await manager.enqueue(context(), [first]);

  const paused = await manager.pause('guild-1');
  assert.equal(paused.current?.title, first.title);
  assert.equal(runtime.sessions.get('guild-1')?.status, 'paused');
  await assert.rejects(
    manager.pause('guild-1'),
    (error) =>
      error instanceof PlaybackRequestError &&
      /already paused/.test(error.message),
  );

  const resumed = await manager.resume('guild-1');
  assert.equal(resumed.current?.title, first.title);
  assert.equal(runtime.sessions.get('guild-1')?.status, 'playing');
  await assert.rejects(
    manager.resume('guild-1'),
    (error) =>
      error instanceof PlaybackRequestError &&
      /already running/.test(error.message),
  );
  await manager.shutdown();
});

test('stop clears playback and queue while retaining the voice session', async () => {
  const { manager, provider, runtime } = await createHarness();
  await manager.enqueue(context(), [track('first')]);
  await manager.enqueue(context(), [track('second')]);

  const result = await manager.stop('guild-1');

  assert.equal(result.stopped?.title, 'Track first');
  assert.equal(result.removedUpcoming, 1);
  assert.deepEqual(manager.snapshot('guild-1'), {
    current: undefined,
    upcoming: [],
  });
  assert.equal(manager.channelId('guild-1'), 'voice-guild-1');
  assert.equal(provider.signals[0]?.aborted, true);
  assert.equal(runtime.sessions.get('guild-1')?.destroyed, false);
  assert.equal(runtime.sessions.get('guild-1')?.status, 'idle');
  await manager.shutdown();
});

test('disconnect clears playback and destroys the voice session immediately', async () => {
  const { manager, provider, runtime } = await createHarness();
  await manager.enqueue(context(), [track('first')]);

  const snapshot = await manager.disconnect('guild-1');

  assert.equal(snapshot.current?.title, 'Track first');
  assert.equal(manager.channelId('guild-1'), undefined);
  assert.equal(provider.signals[0]?.aborted, true);
  assert.equal(runtime.sessions.get('guild-1')?.destroyed, true);
  await manager.shutdown();
});

test('an empty voice channel destroys its session after the grace period', async () => {
  const { manager, runtime } = await createHarness({ emptyChannelGraceMs: 10 });
  await manager.enqueue(context(), [track('first')]);

  await manager.setVoiceChannelEmpty('guild-1', true);
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(manager.channelId('guild-1'), undefined);
  assert.equal(runtime.sessions.get('guild-1')?.destroyed, true);
  await manager.shutdown();
});

test('a returning listener cancels empty-channel cleanup', async () => {
  const { manager, runtime } = await createHarness({ emptyChannelGraceMs: 15 });
  await manager.enqueue(context(), [track('first')]);

  await manager.setVoiceChannelEmpty('guild-1', true);
  await manager.setVoiceChannelEmpty('guild-1', false);
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(manager.channelId('guild-1'), 'voice-guild-1');
  assert.equal(runtime.sessions.get('guild-1')?.destroyed, false);
  await manager.shutdown();
});

test('an unrecoverable connection loss clears and destroys its session', async () => {
  const notifications: string[] = [];
  const { manager, provider, runtime } = await createHarness();
  await manager.enqueue(context('guild-1', notifications), [track('first')]);

  await runtime.loseConnection('guild-1');

  assert.equal(manager.channelId('guild-1'), undefined);
  assert.equal(provider.signals[0]?.aborted, true);
  assert.equal(runtime.sessions.get('guild-1')?.destroyed, true);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0], /voice connection was lost/);
  await manager.shutdown();
});

test('a failed voice connection does not retain a dead session', async () => {
  const { manager, runtime } = await createHarness();
  runtime.failConnection = true;

  await assert.rejects(
    manager.enqueue(context(), [track('first')]),
    /connection failed/,
  );
  assert.equal(manager.channelId('guild-1'), undefined);
  assert.deepEqual(manager.snapshot('guild-1'), { upcoming: [] });
  await manager.shutdown();
});

test('an idle queue notifies the latest text channel and disconnects after the configured timeout', async () => {
  const initialNotifications: string[] = [];
  const latestNotifications: string[] = [];
  const { manager, runtime } = await createHarness({ emptyDisconnectMs: 10 });
  await manager.enqueue(context('guild-1', initialNotifications), [
    track('first'),
  ]);
  await manager.enqueue(context('guild-1', latestNotifications), [
    track('second'),
  ]);
  await runtime.finish('guild-1');
  await runtime.finish('guild-1');
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(manager.channelId('guild-1'), undefined);
  assert.equal(runtime.sessions.get('guild-1')?.destroyed, true);
  assert.deepEqual(initialNotifications, []);
  assert.deepEqual(latestNotifications, [
    '👋 Playback has been idle, so I disconnected from voice.',
  ]);
  await manager.shutdown();
});

test('graceful shutdown destroys every guild session', async () => {
  const { manager, provider, runtime } = await createHarness();
  await manager.enqueue(context('guild-a'), [track('first')]);
  await manager.enqueue(context('guild-b'), [track('second')]);

  await manager.shutdown();

  assert.equal(manager.channelId('guild-a'), undefined);
  assert.equal(manager.channelId('guild-b'), undefined);
  assert.equal(
    provider.signals.every((signal) => signal.aborted),
    true,
  );
  assert.equal(runtime.sessions.get('guild-a')?.destroyed, true);
  assert.equal(runtime.sessions.get('guild-b')?.destroyed, true);
});
