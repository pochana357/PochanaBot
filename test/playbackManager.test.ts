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
import type { SpeechSynthesizer } from '../src/tts/tts-service.js';
import {
  TtsError,
  type TtsAudio,
  type TtsVoicePreset,
} from '../src/tts/tts.js';
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
  readonly volumes: (number | undefined)[] = [];
  readonly decoded: string[] = [];
  readonly failDecode = new Set<string>();
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
        this.plays.push({
          guildId: request.guildId,
          title: (resource as { label: string }).label,
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

  createPipeline(
    source: Readable,
    metadata: object,
    _onError: (error: Error) => void,
    options?: { volume?: number },
  ): PlaybackPipeline {
    // Metadata is a Track for music and a queued utterance for speech.
    const label =
      'title' in metadata
        ? (metadata as Track).title
        : (metadata as { text: string }).text;
    this.volumes.push(options?.volume);
    return {
      resource: { label },
      dispose: () => {
        source.destroy();
        this.disposals.push(label);
      },
    };
  }

  async createSpeechPipeline(
    audio: Buffer,
    metadata: object,
  ): Promise<PlaybackPipeline> {
    const label = (metadata as { text: string }).text;
    this.decoded.push(label);
    if (this.failDecode.has(label)) {
      throw new Error(`cannot decode ${label}`);
    }
    // Speech is never attenuated, so no volume is recorded for it.
    assert.ok(audio.length > 0);
    return {
      resource: { label },
      dispose: () => {
        this.disposals.push(label);
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

class FakeSpeech implements SpeechSynthesizer {
  readonly requests: string[] = [];
  readonly failOn = new Set<string>();

  async synthesize(
    text: string,
    _preset: TtsVoicePreset,
    signal: AbortSignal,
  ): Promise<TtsAudio> {
    this.requests.push(text);
    if (signal.aborted) throw new TtsError('cancelled');
    if (this.failOn.has(text)) throw new TtsError(`cannot speak ${text}`);
    return { data: Buffer.from(text), contentType: 'audio/mpeg' };
  }
}

async function waitFor(
  condition: () => boolean,
  description: string,
): Promise<void> {
  // Speech drains outside the guild lock, so the drive loop settles a few ticks
  // after the event that triggered it.
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${description}`);
}

function utterance(text: string) {
  return {
    text,
    preset: {
      id: 'aria',
      label: 'Aria',
      engine: 'edge',
      voice: 'en-US-AriaNeural',
      language: 'en',
    } satisfies TtsVoicePreset,
    requestedBy: { id: 'user', displayName: 'Tester' },
  };
}

function createHarness(options: PlaybackManagerOptions = {}) {
  const provider = new FakeProvider();
  const runtime = new FakeRuntime();
  const speech = new FakeSpeech();
  const manager = new PlaybackManager(provider, {
    runtime,
    emptyDisconnectMs: 60_000,
    logger: { error() {} },
    speech,
    ...options,
  });
  return { manager, provider, runtime, speech, PlaybackRequestError };
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

test('speaks immediately when nothing is playing', async () => {
  const { manager, runtime, speech } = createHarness();

  const result = await manager.speak(context(), utterance('hello there'));

  assert.equal(result.started, true);
  assert.equal(result.position, 1);
  assert.deepEqual(speech.requests, ['hello there']);
  assert.deepEqual(
    runtime.plays.map(({ title }) => title),
    ['hello there'],
  );
});

test('refuses to speak while a track is loaded, even when paused', async () => {
  const { manager } = createHarness();
  await manager.enqueue(context(), [track('first')]);

  await assert.rejects(
    manager.speak(context(), utterance('hello')),
    /Cannot speak while music is loaded/,
  );

  await manager.pause('guild-1');
  await assert.rejects(
    manager.speak(context(), utterance('hello')),
    /Cannot speak while music is loaded/,
  );
});

test('queues a second utterance and speaks it when the first ends', async () => {
  const { manager, runtime } = createHarness();

  await manager.speak(context(), utterance('first message'));
  const second = await manager.speak(context(), utterance('second message'));
  assert.equal(second.started, false);
  assert.equal(second.position, 1);
  assert.deepEqual(
    runtime.plays.map(({ title }) => title),
    ['first message'],
  );

  await runtime.finish('guild-1');
  await waitFor(() => runtime.plays.length === 2, 'the second utterance');
  assert.deepEqual(
    runtime.plays.map(({ title }) => title),
    ['first message', 'second message'],
  );
});

test('rejects an utterance once the speech queue is full', async () => {
  const { manager } = createHarness({ maxSpeechQueueLength: 1 });

  await manager.speak(context(), utterance('first'));
  await manager.speak(context(), utterance('second'));

  await assert.rejects(
    manager.speak(context(), utterance('third')),
    /can wait to be spoken/,
  );
});

test('music queued during speech waits, then starts when the utterance ends', async () => {
  const { manager, runtime } = createHarness();
  await manager.speak(context(), utterance('hold on'));

  const queued = await manager.enqueue(context(), [track('first')]);
  assert.equal(queued.started, false);
  assert.deepEqual(
    runtime.plays.map(({ title }) => title),
    ['hold on'],
  );

  await runtime.finish('guild-1');
  assert.deepEqual(
    runtime.plays.map(({ title }) => title),
    ['hold on', 'Track first'],
  );
  assert.equal(manager.snapshot('guild-1').current?.title, 'Track first');
});

test('waiting music drops the remaining utterances and says so', async () => {
  const notifications: string[] = [];
  const { manager, runtime } = createHarness();

  await manager.speak(context('guild-1', notifications), utterance('one'));
  await manager.speak(context('guild-1', notifications), utterance('two'));
  await manager.enqueue(context('guild-1', notifications), [track('first')]);

  await runtime.finish('guild-1');

  assert.deepEqual(
    runtime.plays.map(({ title }) => title),
    ['one', 'Track first'],
  );
  assert.ok(
    notifications.some((message) =>
      /1 queued message was dropped/.test(message),
    ),
  );
});

test('a synthesis failure is reported to the caller and leaves nothing playing', async () => {
  const { manager, runtime, speech } = createHarness();
  speech.failOn.add('broken');

  await assert.rejects(
    manager.speak(context(), utterance('broken')),
    /cannot speak broken/,
  );
  assert.deepEqual(runtime.plays, []);

  // The session stays usable for the next request.
  await manager.speak(context(), utterance('fine'));
  assert.deepEqual(
    runtime.plays.map(({ title }) => title),
    ['fine'],
  );
});

test('a queued utterance that fails to synthesize drains to the next one', async () => {
  const notifications: string[] = [];
  const { manager, runtime, speech } = createHarness();
  speech.failOn.add('broken');

  await manager.speak(context('guild-1', notifications), utterance('first'));
  await manager.speak(context('guild-1', notifications), utterance('broken'));
  await manager.speak(context('guild-1', notifications), utterance('last'));

  await runtime.finish('guild-1');
  await waitFor(() => runtime.plays.length === 2, 'the queue to drain');

  assert.deepEqual(
    runtime.plays.map(({ title }) => title),
    ['first', 'last'],
  );
  assert.ok(
    notifications.some((message) => /cannot speak broken/.test(message)),
  );
});

test('stop cancels the current utterance and clears the speech queue', async () => {
  const { manager, runtime } = createHarness();
  await manager.speak(context(), utterance('first'));
  await manager.speak(context(), utterance('second'));

  await manager.stop('guild-1');

  assert.deepEqual(runtime.disposals, ['first']);
  await runtime.finish('guild-1');
  assert.deepEqual(
    runtime.plays.map(({ title }) => title),
    ['first'],
  );
  assert.equal(runtime.sessions.get('guild-1')?.destroyed, false);
});

test('the idle disconnect timer does not fire while speech is pending', async () => {
  const { manager, runtime } = createHarness({ emptyDisconnectMs: 5 });
  await manager.speak(context(), utterance('first'));
  await manager.speak(context(), utterance('second'));

  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(runtime.sessions.get('guild-1')?.destroyed, false);

  await runtime.finish('guild-1');
  await waitFor(() => runtime.plays.length === 2, 'the second utterance');
  await runtime.finish('guild-1');
  await waitFor(
    () => runtime.sessions.get('guild-1')?.destroyed === true,
    'the idle disconnect',
  );
});

test('speaking is refused when no synthesizer is configured', async () => {
  const { manager } = createHarness({ speech: undefined });

  await assert.rejects(
    manager.speak(context(), utterance('hello')),
    /Text to speech is not configured/,
  );
});

test('music is attenuated and speech is not', async () => {
  const { manager, runtime } = createHarness();

  await manager.speak(context(), utterance('spoken'));
  await runtime.finish('guild-1');
  await waitFor(() => runtime.plays.length === 1, 'the utterance');
  await manager.enqueue(context(), [track('first')]);

  // Speech goes through createSpeechPipeline, which records no volume at all.
  assert.deepEqual(runtime.volumes, [0.5]);
  assert.deepEqual(runtime.decoded, ['spoken']);
});

test('the music volume is configurable', async () => {
  const { manager, runtime } = createHarness({ musicVolume: 1 });
  await manager.enqueue(context(), [track('first')]);
  assert.deepEqual(runtime.volumes, [1]);
});

test('stop interrupts synthesis instead of waiting for it', async () => {
  let started = false;
  let aborted = false;
  const speech = {
    async synthesize(_text: string, _preset: unknown, signal: AbortSignal) {
      started = true;
      // Stands in for a request that hangs until the engine's own timeout.
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          resolve();
        });
      });
      throw new TtsError('cancelled');
    },
  };
  const { manager, runtime } = createHarness({ speech });

  const speaking = manager
    .speak(context(), utterance('slow'))
    .catch((error: Error) => error.message);
  await waitFor(() => started, 'synthesis to start');

  // Would block for the engine's full timeout if synthesis held the guild lock.
  await manager.stop('guild-1');

  assert.equal(aborted, true);
  assert.deepEqual(runtime.plays, []);
  assert.match(String(await speaking), /cancelled/);
});

test('an utterance that cannot be decoded is reported before it is announced', async () => {
  const { manager, runtime } = createHarness();
  runtime.failDecode.add('undecodable');

  await assert.rejects(
    manager.speak(context(), utterance('undecodable')),
    /cannot decode undecodable/,
  );
  // Nothing was ever handed to the player, so nothing was announced as spoken.
  assert.deepEqual(runtime.plays, []);
  assert.deepEqual(runtime.decoded, ['undecodable']);
});

test('a stop during synthesis discards the result instead of playing it', async () => {
  let release: (() => void) | undefined;
  const speech = {
    async synthesize(text: string) {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { data: Buffer.from(text), contentType: 'audio/mpeg' };
    },
  };
  const { manager, runtime } = createHarness({ speech });

  const speaking = manager
    .speak(context(), utterance('late'))
    .catch(() => 'rejected');
  await waitFor(() => release !== undefined, 'synthesis to start');
  await manager.stop('guild-1');

  // Synthesis finishes after the stop; the generation check must discard it.
  release?.();
  // Resolving here would let /tts announce audio that was thrown away.
  assert.equal(await speaking, 'rejected');
  await waitFor(
    () => runtime.disposals.includes('late'),
    'the discarded audio',
  );
  assert.deepEqual(runtime.plays, []);
});

test('a discarded utterance is reported as cancelled, not as spoken', async () => {
  let release: (() => void) | undefined;
  const speech = {
    async synthesize(text: string) {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { data: Buffer.from(text), contentType: 'audio/mpeg' };
    },
  };
  const { manager } = createHarness({ speech });

  const speaking = manager.speak(context(), utterance('late'));
  await waitFor(() => release !== undefined, 'synthesis to start');
  await manager.stop('guild-1');
  release?.();

  await assert.rejects(speaking, /cancelled before it could be spoken/);
});

test('a first synthesis failure still speaks the utterance queued behind it', async () => {
  const notifications: string[] = [];
  const { manager, runtime, speech } = createHarness({ emptyDisconnectMs: 5 });
  let release: (() => void) | undefined;
  const failing = speech.synthesize.bind(speech);
  speech.synthesize = async (text, preset, signal) => {
    // Hold the first utterance open long enough for the second to queue behind
    // it, so its failure is the one rethrown to the caller.
    if (text === 'broken') {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    return failing(text, preset, signal);
  };
  speech.failOn.add('broken');

  const first = manager
    .speak(context('guild-1', notifications), utterance('broken'))
    .catch((error: Error) => error.message);
  await waitFor(() => release !== undefined, 'the first synthesis to start');
  const second = await manager.speak(
    context('guild-1', notifications),
    utterance('waiting'),
  );
  release?.();

  assert.equal(second.started, false);
  assert.match(String(await first), /cannot speak broken/);
  // Without a hand-off the drive loop would stop here, leaving 'waiting'
  // unspoken and the session pinned open by a queue nothing drains.
  await waitFor(
    () => runtime.plays.length === 1,
    'the queued utterance to be spoken',
  );
  assert.deepEqual(
    runtime.plays.map(({ title }) => title),
    ['waiting'],
  );

  await runtime.finish('guild-1');
  await waitFor(
    () => runtime.sessions.get('guild-1')?.destroyed === true,
    'the idle disconnect',
  );
});

test('a failed claim from a destroyed session cannot clear its replacement', async () => {
  const pending = new Map<string, { settle(fail: boolean): void }>();
  const { manager, runtime } = createHarness({
    speech: {
      async synthesize(text: string) {
        await new Promise<void>((resolve, reject) => {
          pending.set(text, {
            settle: (fail) =>
              fail ? reject(new TtsError(`cannot speak ${text}`)) : resolve(),
          });
        });
        return { data: Buffer.from(text), contentType: 'audio/mpeg' };
      },
    },
  });

  const stale = manager
    .speak(context(), utterance('stale'))
    .catch((error: Error) => error.message);
  await waitFor(() => pending.has('stale'), 'the first synthesis to start');

  // Torn down and rebuilt while synthesis is still running: the replacement
  // session starts its generation counter over, so its first utterance is
  // numbered exactly like the claim still in flight against the old one.
  await manager.disconnect('guild-1');
  const fresh = manager.speak(context(), utterance('fresh'));
  await waitFor(() => pending.has('fresh'), 'the second synthesis to start');

  // Failing the stale claim runs its release path against the live session.
  // Matching on the generation number alone would clear and abort 'fresh'.
  pending.get('stale')?.settle(true);
  assert.match(String(await stale), /cannot speak stale/);

  pending.get('fresh')?.settle(false);
  assert.equal((await fresh).started, true);
  assert.deepEqual(
    runtime.plays.map(({ title }) => title),
    ['fresh'],
  );
});
