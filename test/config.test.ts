import assert from 'node:assert/strict';
import { test } from 'vitest';
import { requireDiscordId, requireEnvironment } from '../src/config.js';

test('environment validation trims required values', () => {
  assert.equal(
    requireEnvironment('DISCORD_TOKEN', { DISCORD_TOKEN: '  token  ' }),
    'token',
  );
  assert.throws(
    () => requireEnvironment('DISCORD_TOKEN', { DISCORD_TOKEN: '   ' }),
    /Missing required environment variable: DISCORD_TOKEN/,
  );
});

test('Discord IDs must be numeric snowflakes', () => {
  assert.equal(
    requireDiscordId('DISCORD_CLIENT_ID', {
      DISCORD_CLIENT_ID: '123456789012345678',
    }),
    '123456789012345678',
  );
  assert.throws(
    () =>
      requireDiscordId('DISCORD_CLIENT_ID', { DISCORD_CLIENT_ID: 'not-an-id' }),
    /17 to 20 digits/,
  );
});
