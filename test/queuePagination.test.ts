import assert from 'node:assert/strict';
import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
} from 'discord.js';
import { test } from 'vitest';
import {
  buildQueuePaginationRow,
  createQueueCommand,
  handleQueueButton,
  QUEUE_BROWSE_CUSTOM_ID,
  queuePageCustomId,
} from '../src/commands/queue.js';
import type { Logger } from '../src/logger.js';
import type { Track } from '../src/media.js';
import type {
  PlaybackManager,
  QueueSnapshot,
} from '../src/playback-manager.js';
import { buildQueuePageEmbed } from '../src/presentation/playback-responses.js';

type ButtonData = {
  custom_id?: string;
  disabled?: boolean;
  label?: string;
};

type ActionRowData = {
  components: ButtonData[];
};

type ResponsePayload = {
  content?: string;
  components?: Array<{ toJSON(): ActionRowData }>;
  embeds?: Array<{
    toJSON(): { description?: string; footer?: { text?: string } };
  }>;
  flags?: number;
};

function makeTrack(index: number): Track {
  const id = String(index).padStart(11, '0');
  return {
    provider: 'youtube',
    id,
    title: `Track ${index}`,
    webpageUrl: `https://www.youtube.com/watch?v=${id}`,
    durationSeconds: 60,
    requestedBy: { id: 'user-1', displayName: 'Listener' },
  };
}

function snapshot(upcomingCount: number): QueueSnapshot {
  return {
    current: makeTrack(0),
    upcoming: Array.from({ length: upcomingCount }, (_, index) =>
      makeTrack(index + 1),
    ),
  };
}

const quietLogger: Pick<Logger, 'error'> = {
  error: () => undefined,
};

test('/queue adds Browse only when a second page exists', async () => {
  for (const [upcomingCount, shouldBrowse] of [
    [10, false],
    [11, true],
  ] as const) {
    const replies: ResponsePayload[] = [];
    const playback = {
      snapshot: () => snapshot(upcomingCount),
    } as unknown as PlaybackManager;
    const interaction = {
      guildId: 'guild-1',
      inCachedGuild: () => true,
      reply: async (payload: ResponsePayload) => replies.push(payload),
    } as unknown as ChatInputCommandInteraction;

    await createQueueCommand(playback).execute(interaction);

    const rows = replies[0]?.components ?? [];
    assert.equal(rows.length, shouldBrowse ? 1 : 0);
    if (shouldBrowse) {
      const button = rows[0]?.toJSON().components[0];
      assert.equal(button?.custom_id, QUEUE_BROWSE_CUSTOM_ID);
      assert.equal(button?.label, 'Browse full queue');
    }
  }
});

test('private queue pages use absolute positions and expose boundary controls', () => {
  const queue = snapshot(24);
  const embed = buildQueuePageEmbed(queue, 2).toJSON();
  assert.match(embed.description ?? '', /\*\*Now playing\*\*/);
  assert.match(embed.description ?? '', /11\. \[Track 11\]/);
  assert.match(embed.description ?? '', /20\. \[Track 20\]/);
  assert.doesNotMatch(embed.description ?? '', /10\. \[Track 10\]/);
  assert.doesNotMatch(embed.description ?? '', /21\. \[Track 21\]/);
  assert.equal(embed.footer?.text, 'Page 2 of 3 • 24 upcoming tracks');

  const buttons = buildQueuePaginationRow(queue, 2)?.toJSON().components as
    ButtonData[] | undefined;
  assert.ok(buttons);
  assert.equal(buttons.length, 4);
  assert.equal(
    new Set(buttons.map(({ custom_id }) => custom_id)).size,
    buttons.length,
  );
  assert.equal(buttons[0]?.disabled, false);
  assert.equal(buttons[1]?.disabled, false);
  assert.equal(buttons[2]?.disabled, false);
  assert.equal(buttons[3]?.disabled, false);

  const firstPage = buildQueuePaginationRow(queue, 1)?.toJSON().components;
  assert.equal(firstPage?.[0]?.disabled, true);
  assert.equal(firstPage?.[1]?.disabled, true);
});

test('a vanished page stays visible and navigates directly to live pages', () => {
  const queue = snapshot(15);
  const embed = buildQueuePageEmbed(queue, 4).toJSON();
  assert.match(
    embed.description ?? '',
    /No upcoming tracks remain on page 4\./,
  );
  assert.equal(
    embed.footer?.text,
    'Page 4 is empty • Queue currently ends on page 2 • 15 upcoming tracks',
  );

  const buttons = buildQueuePaginationRow(queue, 4)?.toJSON().components as
    ButtonData[] | undefined;
  assert.ok(buttons);
  assert.equal(buttons[0]?.custom_id, queuePageCustomId('first', 1));
  assert.equal(buttons[1]?.custom_id, queuePageCustomId('previous', 2));
  assert.equal(buttons[2]?.disabled, true);
  assert.equal(buttons[3]?.disabled, true);
});

test('a current track without upcoming tracks remains a valid page one', () => {
  const queue = snapshot(0);
  const embed = buildQueuePageEmbed(queue, 1).toJSON();
  assert.match(embed.description ?? '', /\*\*Now playing\*\*/);
  assert.doesNotMatch(embed.description ?? '', /No upcoming tracks remain/);
  assert.equal(embed.footer?.text, 'Page 1 of 1 • 0 upcoming tracks');
  assert.equal(buildQueuePaginationRow(queue, 1), undefined);
});

test('Browse opens a private live page two without updating the public message', async () => {
  const replies: ResponsePayload[] = [];
  let updateCalls = 0;
  const playback = {
    snapshot: () => snapshot(24),
  } as unknown as PlaybackManager;
  const interaction = buttonInteraction(QUEUE_BROWSE_CUSTOM_ID, {
    reply: async (payload) => replies.push(payload),
    update: async () => {
      updateCalls += 1;
    },
  });

  assert.equal(
    await handleQueueButton(interaction, playback, quietLogger),
    true,
  );

  assert.equal(updateCalls, 0);
  assert.equal(replies[0]?.flags, 64);
  assert.match(
    replies[0]?.embeds?.[0]?.toJSON().description ?? '',
    /11\. \[Track 11\]/,
  );
});

test('Browse preserves an empty page two when the live queue shrank', async () => {
  const replies: ResponsePayload[] = [];
  const playback = {
    snapshot: () => snapshot(10),
  } as unknown as PlaybackManager;
  const interaction = buttonInteraction(QUEUE_BROWSE_CUSTOM_ID, {
    reply: async (payload) => replies.push(payload),
  });

  await handleQueueButton(interaction, playback, quietLogger);

  const embed = replies[0]?.embeds?.[0]?.toJSON();
  assert.match(embed?.description ?? '', /No upcoming tracks remain on page 2/);
  assert.equal(
    embed?.footer?.text,
    'Page 2 is empty • Queue currently ends on page 1 • 10 upcoming tracks',
  );
  const buttons = replies[0]?.components?.[0]?.toJSON().components;
  assert.equal(buttons?.[1]?.custom_id, queuePageCustomId('previous', 1));
  assert.equal(buttons?.[2]?.disabled, true);
});

test('private navigation re-reads live additions and clears a removed queue', async () => {
  let liveSnapshot: QueueSnapshot = snapshot(10);
  const updates: ResponsePayload[] = [];
  const playback = {
    snapshot: () => liveSnapshot,
  } as unknown as PlaybackManager;

  liveSnapshot = snapshot(25);
  await handleQueueButton(
    buttonInteraction(queuePageCustomId('next', 2), {
      update: async (payload) => updates.push(payload),
    }),
    playback,
    quietLogger,
  );
  assert.match(
    updates[0]?.embeds?.[0]?.toJSON().description ?? '',
    /11\. \[Track 11\]/,
  );
  assert.equal(
    updates[0]?.embeds?.[0]?.toJSON().footer?.text,
    'Page 2 of 3 • 25 upcoming tracks',
  );

  liveSnapshot = { upcoming: [] };
  await handleQueueButton(
    buttonInteraction(queuePageCustomId('next', 3), {
      update: async (payload) => updates.push(payload),
    }),
    playback,
    quietLogger,
  );
  assert.deepEqual(updates[1], {
    content: 'The playback queue is empty.',
    embeds: [],
    components: [],
  });
});

test('unrelated and malformed button identifiers are ignored', async () => {
  let snapshotCalls = 0;
  const playback = {
    snapshot: () => {
      snapshotCalls += 1;
      return snapshot(20);
    },
  } as unknown as PlaybackManager;

  for (const customId of [
    'another-feature',
    'queue:v1:page:next:0',
    'queue:v1:page:next:9007199254740992',
    'queue:v1:page:unknown:2',
  ]) {
    assert.equal(
      await handleQueueButton(
        buttonInteraction(customId),
        playback,
        quietLogger,
      ),
      false,
    );
  }
  assert.equal(snapshotCalls, 0);
});

test('queue component failures are logged and receive a private error', async () => {
  const replies: ResponsePayload[] = [];
  const errors: Array<{
    event: string;
    error: unknown;
    context: Readonly<Record<string, unknown>> | undefined;
  }> = [];
  const failure = new Error('snapshot failed');
  const playback = {
    snapshot: () => {
      throw failure;
    },
  } as unknown as PlaybackManager;
  const logger: Pick<Logger, 'error'> = {
    error: (event, error, context) => errors.push({ event, error, context }),
  };
  const interaction = buttonInteraction(QUEUE_BROWSE_CUSTOM_ID, {
    reply: async (payload) => replies.push(payload),
  });

  assert.equal(await handleQueueButton(interaction, playback, logger), true);

  assert.equal(errors[0]?.event, 'queue_component_error');
  assert.equal(errors[0]?.error, failure);
  assert.equal(JSON.stringify(errors[0]?.context).includes('token'), false);
  assert.equal(replies[0]?.flags, 64);
  assert.match(replies[0]?.content ?? '', /run `\/queue` again/);
});

function buttonInteraction(
  customId: string,
  methods: {
    reply?: (payload: ResponsePayload) => Promise<unknown>;
    update?: (payload: ResponsePayload) => Promise<unknown>;
  } = {},
): ButtonInteraction {
  return {
    id: 'interaction-1',
    customId,
    token: 'never-log-this-token',
    user: { id: 'user-1' },
    guildId: 'guild-1',
    channelId: 'channel-1',
    deferred: false,
    replied: false,
    inCachedGuild: () => true,
    reply: methods.reply ?? (async () => undefined),
    update: methods.update ?? (async () => undefined),
    followUp: async () => undefined,
  } as unknown as ButtonInteraction;
}
