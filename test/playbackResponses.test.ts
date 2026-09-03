import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { Track } from '../src/media.js';
import {
  escapeMarkdown,
  formatDuration,
  linkedTrack,
  truncate,
} from '../src/presentation/discord-format.js';
import {
  buildPlayAcknowledgement,
  buildQueueEmbed,
  disconnectMessage,
  idleDisconnectMessage,
  pauseMessage,
  playlistMessage,
  removeMessage,
  resumeMessage,
  skipMessage,
  stopMessage,
} from '../src/presentation/playback-responses.js';

function makeTrack(index = 0, overrides: Partial<Track> = {}): Track {
  const id = String(index).padStart(11, '0');
  return {
    provider: 'youtube',
    id,
    title: `Track ${index}`,
    webpageUrl: `https://www.youtube.com/watch?v=${id}`,
    durationSeconds: 60,
    requestedBy: { id: 'user-1', displayName: 'Listener' },
    ...overrides,
  };
}

test('/play acknowledgement identifies the resolved track and queue status', () => {
  const track = makeTrack(1, {
    id: 'OlXr5YD-MWA',
    title: 'Beyond Love (Feat. 10CM)',
    webpageUrl: 'https://www.youtube.com/watch?v=OlXr5YD-MWA',
    durationSeconds: 189,
    thumbnailUrl: 'https://i.ytimg.com/vi/OlXr5YD-MWA/hqdefault.jpg',
    requestedBy: { id: 'user-1', displayName: 'Earl' },
  });

  const nowPlaying = buildPlayAcknowledgement(track, true, 1).toJSON();
  assert.equal(nowPlaying.author?.name, '▶️ Now playing');
  assert.equal(nowPlaying.title, track.title);
  assert.equal(nowPlaying.url, track.webpageUrl);
  assert.match(nowPlaying.description ?? '', /Open on YouTube/);
  assert.deepEqual(
    nowPlaying.fields?.map((field) => field.value),
    ['3:09'],
  );
  assert.equal(nowPlaying.footer?.text, 'Requested by Earl');
  assert.equal(nowPlaying.thumbnail?.url, track.thumbnailUrl);

  const queued = buildPlayAcknowledgement(track, false, 3).toJSON();
  assert.equal(queued.author?.name, '➕ Added to queue');
  assert.equal(queued.fields?.[1]?.value, '3');

  const playingNext = buildPlayAcknowledgement(
    track,
    false,
    1,
    'front',
  ).toJSON();
  assert.equal(playingNext.author?.name, '⏭️ Playing next');
  assert.equal(playingNext.title, track.title);
  assert.equal(playingNext.url, track.webpageUrl);
  assert.equal(playingNext.fields?.[1]?.value, '1');
});

test('/queue shows at most ten upcoming tracks and reports the hidden remainder', () => {
  const embed = buildQueueEmbed({
    current: makeTrack(0),
    upcoming: Array.from({ length: 12 }, (_, index) => makeTrack(index + 1)),
  }).toJSON();

  assert.ok(
    (embed.description ?? '').indexOf('**Now playing**') <
      (embed.description ?? '').indexOf('**Up next**'),
  );
  assert.match(embed.description ?? '', /\*\*Now playing\*\*\n\[Track 0\]/);
  assert.match(embed.description ?? '', /10\. \[Track 10\]/);
  assert.match(embed.description ?? '', /…and 2 more/);
  assert.doesNotMatch(embed.description ?? '', /Track 11/);
  assert.ok(
    (embed.description ?? '').endsWith(
      'Use `/remove tracks:12` or `/remove tracks:12-20` to remove upcoming tracks.',
    ),
  );
  assert.equal(embed.fields?.length ?? 0, 0);
});

test('/playlist reports how many individual tracks were queued', () => {
  const playlistUrl =
    'https://www.youtube.com/watch?v=Rt9tW3cMLhI&list=PLcirGkCPmbmFeQ1sm4wFciF03D_EroIfr';
  assert.equal(
    playlistMessage(100, true, 1, playlistUrl),
    `▶️ Started a playlist with **100 tracks**: ${playlistUrl}`,
  );
  assert.equal(
    playlistMessage(100, false, 2, playlistUrl),
    `➕ Added **100 tracks** to the queue, starting at position **2**: ${playlistUrl}`,
  );
});

test('/remove identifies a single track or summarizes a range', () => {
  const first = makeTrack(1);
  const second = makeTrack(2);
  assert.equal(
    removeMessage({
      removed: [first],
      startPosition: 1,
      endPosition: 1,
      snapshot: { upcoming: [] },
    }),
    `🗑️ Removed [Track 1](${first.webpageUrl}) from the queue.`,
  );
  assert.equal(
    removeMessage({
      removed: [first, second],
      startPosition: 3,
      endPosition: 4,
      snapshot: { upcoming: [] },
    }),
    '🗑️ Removed **2 tracks** (positions **3–4**) from the queue.',
  );
});

test('voice-control responses preserve links, markdown escaping, and queue outcomes', () => {
  const current = makeTrack(1, { title: 'A *linked* track' });
  const skipped = makeTrack(2, { title: 'A _skipped_ track' });

  assert.equal(
    pauseMessage({ current, upcoming: [] }),
    `⏸️ Paused [A *linked* track](${current.webpageUrl}).`,
  );
  assert.equal(
    resumeMessage({ current, upcoming: [] }),
    `▶️ Resumed [A *linked* track](${current.webpageUrl}).`,
  );
  assert.equal(
    skipMessage({
      skipped,
      startedNext: true,
      snapshot: { current, upcoming: [] },
    }),
    '⏭️ Skipped to **A \\*linked\\* track**.',
  );
  assert.equal(
    skipMessage({ skipped, startedNext: false, snapshot: { upcoming: [] } }),
    '⏹️ Stopped **A \\_skipped\\_ track** because the queue is empty.',
  );
  assert.equal(
    stopMessage({ removedUpcoming: 1 }),
    '⏹️ Playback stopped and 1 queued track cleared.',
  );
  assert.equal(
    stopMessage({ removedUpcoming: 2 }),
    '⏹️ Playback stopped and 2 queued tracks cleared.',
  );
  assert.equal(
    disconnectMessage(),
    '👋 Playback cleared and voice disconnected.',
  );
  assert.equal(
    idleDisconnectMessage(),
    '👋 Playback has been idle, so I disconnected from voice.',
  );
});

test('Discord formatting helpers escape text without corrupting masked-link labels', () => {
  const title =
    '[MV] 이수현 (LEE SUHYUN)_ 푸른 산호초 (Blue Lagoon (Korean Ver.)): J-POP REMAKE Vol.3';
  const webpageUrl = 'https://www.youtube.com/watch?v=UjfHU8pLaJE';

  assert.equal(formatDuration(189), '3:09');
  assert.equal(formatDuration(3661), '1:01:01');
  assert.equal(truncate('abcdef', 4), 'abc…');
  assert.equal(escapeMarkdown('a *track* [name]'), 'a \\*track\\* [name]');
  assert.equal(linkedTrack({ title, webpageUrl }), `[${title}](${webpageUrl})`);
});
