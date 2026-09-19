import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  defaultPresetId,
  findPreset,
  presetChoices,
  voicePresets,
} from '../../src/tts/presets.js';
import { MAX_TTS_TEXT_LENGTH, TtsService } from '../../src/tts/tts-service.js';
import {
  TtsError,
  type TtsAudio,
  type TtsEngine,
  type TtsEngineId,
  type TtsVoicePreset,
} from '../../src/tts/tts.js';
import { InMemoryVoicePreferenceStore } from '../../src/tts/voice-preferences.js';

class FakeEngine implements TtsEngine {
  readonly calls: TtsVoicePreset[] = [];
  constructor(readonly id: TtsEngineId) {}
  async synthesize(_text: string, preset: TtsVoicePreset): Promise<TtsAudio> {
    this.calls.push(preset);
    return { data: Buffer.from(this.id), contentType: 'audio/mpeg' };
  }
}

function service(...ids: TtsEngineId[]) {
  const engines = (ids.length ? ids : (['edge', 'fish'] as TtsEngineId[])).map(
    (id) => new FakeEngine(id),
  );
  return {
    tts: new TtsService(engines, new InMemoryVoicePreferenceStore()),
    engines,
  };
}

test('the default preset resolves to an engine the bot registers', () => {
  const preset = findPreset(defaultPresetId);
  assert.ok(preset, 'the default preset id must resolve');
  assert.ok(['edge', 'fish'].includes(preset.engine));
});

test('every preset names an engine the bot registers', () => {
  for (const preset of voicePresets) {
    assert.ok(
      ['edge', 'fish'].includes(preset.engine),
      `${preset.id} names an unknown engine`,
    );
  }
});

test('preset ids are unique so preferences resolve deterministically', () => {
  const ids = voicePresets.map((preset) => preset.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('a user who never ran /preset-tts gets the default preset', () => {
  const { tts } = service();
  assert.equal(tts.presetFor('never-set-a-voice').id, defaultPresetId);
});

test('a preference left over from a removed preset falls back to the default', () => {
  const store = new InMemoryVoicePreferenceStore();
  store.set('user', 'a-preset-that-no-longer-exists');
  const tts = new TtsService([new FakeEngine('edge')], store);
  assert.equal(tts.presetFor('user').id, defaultPresetId);
});

test('a chosen preset is remembered and used', () => {
  const { tts } = service();
  const chosen = tts.selectPreset('user', 'sarah');
  assert.equal(chosen.engine, 'fish');
  assert.equal(tts.presetFor('user').id, 'sarah');
  // One user's choice does not leak to another.
  assert.equal(tts.presetFor('other-user').id, defaultPresetId);
});

test('choosing a preset that does not exist is rejected', () => {
  const { tts } = service();
  assert.throws(() => tts.selectPreset('user', 'nope'), TtsError);
});

test('synthesis is routed to the engine the preset names', async () => {
  const { tts, engines } = service();
  const signal = new AbortController().signal;

  // Named explicitly rather than via the default, which may be either engine.
  await tts.synthesize('hi', tts.selectPreset('user', 'aria'), signal);
  await tts.synthesize('hi', tts.selectPreset('user', 'sarah'), signal);

  assert.deepEqual(
    engines.map((engine) => engine.calls.length),
    [1, 1],
  );
});

// This is the only way "the engine is unavailable" can surface, and it means a
// wiring mistake rather than anything the user did.
test('a preset whose engine was never registered reports which engine is missing', async () => {
  const { tts } = service('edge');
  await assert.rejects(
    tts.synthesize(
      'hi',
      tts.selectPreset('user', 'sarah'),
      new AbortController().signal,
    ),
    /fish voice engine is unavailable/,
  );
});

test('text is trimmed, and empty or oversized text is rejected', () => {
  assert.equal(TtsService.normalizeText('  hello  '), 'hello');
  assert.throws(() => TtsService.normalizeText('   '), TtsError);
  assert.throws(
    () => TtsService.normalizeText('x'.repeat(MAX_TTS_TEXT_LENGTH + 1)),
    TtsError,
  );
  assert.equal(
    TtsService.normalizeText('x'.repeat(MAX_TTS_TEXT_LENGTH)).length,
    MAX_TTS_TEXT_LENGTH,
  );
});

// Fish states the rule in its 400 response: "reference_id must be 1..=128 chars
// of [A-Za-z0-9_-]". A pasted voice URL keeps its trailing slash and fails only
// once someone selects the preset and speaks, well after /preset-tts says it
// worked.
test('every Fish preset carries a well-formed reference id', () => {
  for (const preset of voicePresets) {
    if (preset.engine !== 'fish') continue;
    assert.match(
      preset.voice,
      /^[A-Za-z0-9_-]{1,128}$/,
      `${preset.id} has a reference id Fish will reject: ${JSON.stringify(preset.voice)}`,
    );
  }
});

test('no preset voice carries stray URL or whitespace characters', () => {
  for (const preset of voicePresets) {
    assert.ok(preset.voice.length > 0, `${preset.id} has an empty voice`);
    assert.equal(
      preset.voice,
      preset.voice.trim(),
      `${preset.id} has padded whitespace`,
    );
    assert.doesNotMatch(
      preset.voice,
      /[/\s]/,
      `${preset.id} looks like it came from a pasted URL: ${JSON.stringify(preset.voice)}`,
    );
  }
});

// /preset-tts renders these as command choices, and Discord refuses the whole
// deployment if the catalog outgrows its limits.
test('the preset catalog fits Discord command choice limits', () => {
  const choices = presetChoices();
  assert.ok(
    choices.length <= 25,
    `Discord allows 25 choices; the catalog has ${choices.length}`,
  );
  for (const choice of choices) {
    assert.ok(
      choice.name.length > 0 && choice.name.length <= 100,
      choice.value,
    );
    assert.ok(
      choice.value.length > 0 && choice.value.length <= 100,
      choice.value,
    );
  }
});
