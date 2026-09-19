import type { TtsVoicePreset } from './tts.js';

// Curated engine+voice combinations. Discord allows at most 25 command choices,
// so this list is deliberately short rather than exhaustive.
export const voicePresets: readonly TtsVoicePreset[] = Object.freeze([
  // Fish: higher quality and more expressive, requires FISH_API_KEY.
  {
    id: 'adrian',
    label: 'Adrian (English, Fish)',
    engine: 'fish',
    voice: 'bf322df2096a46f18c579d0baa36f41d',
    language: 'en',
  },
  {
    id: 'sarah',
    label: 'Sarah (English, Fish)',
    engine: 'fish',
    voice: '933563129e564b19a115bedd57b7406a',
    language: 'en',
  },
  {
    id: 'korean-female01',
    label: '루미 (Korean, Fish)',
    engine: 'fish',
    voice: 'bf24b16a54f14e36a0e4cb4ed8a75080',
    language: 'ko',
  },
  {
    id: 'korean-female02',
    label: '여성2 (Korean, Fish)',
    engine: 'fish',
    voice: '4e118bfbb83e401c84699c09b5f08257',
    language: 'ko',
  },
  {
    id: 'korean-male01',
    label: '남성1 (Korean, Fish)',
    engine: 'fish',
    voice: 'b2cff239d5e74611b12b0159a3b673ff',
    language: 'ko',
  },
  {
    id: 'korean-male02',
    label: '남성2 (Korean, Fish)',
    engine: 'fish',
    voice: '630d0284836a4d189a8e847030945727',
    language: 'ko',
  },
  {
    id: 'satoru',
    label: 'さとる (Japanese, Fish)',
    engine: 'fish',
    voice: '297a6fd278df47c3b9da9bfdf55ac89a',
    language: 'ja',
  },
  {
    id: 'shiori',
    label: 'しおり (Japanese, Fish)',
    engine: 'fish',
    voice: '5da7f24e9e274f91b2b677669c818ce9',
    language: 'ja',
  },
  // Edge: free, fast, no API key.
  {
    id: 'aria',
    label: 'Aria (English, Edge)',
    engine: 'edge',
    voice: 'en-US-AriaNeural',
    language: 'en',
  },
  {
    id: 'guy',
    label: 'Guy (English, Edge)',
    engine: 'edge',
    voice: 'en-US-GuyNeural',
    language: 'en',
  },
  {
    id: 'sunhi',
    label: '선희 (Korean, Edge)',
    engine: 'edge',
    voice: 'ko-KR-SunHiNeural',
    language: 'ko',
  },
  {
    id: 'injoon',
    label: '인준 (Korean, Edge)',
    engine: 'edge',
    voice: 'ko-KR-InJoonNeural',
    language: 'ko',
  },
  {
    id: 'nanami',
    label: '七海 (Japanese, Edge)',
    engine: 'edge',
    voice: 'ja-JP-NanamiNeural',
    language: 'ja',
  },
  {
    id: 'keita',
    label: '圭太 (Japanese, Edge)',
    engine: 'edge',
    voice: 'ja-JP-KeitaNeural',
    language: 'ja',
  },
]);

// This is a Fish preset, so /tts needs FISH_API_KEY out of the box. Point it at
// an Edge preset instead to make the fallback work without credentials.
export const defaultPresetId = 'korean-female01';

export function findPreset(id: string): TtsVoicePreset | undefined {
  return voicePresets.find((preset) => preset.id === id);
}

export function defaultPreset(): TtsVoicePreset {
  const preset = findPreset(defaultPresetId);
  if (!preset) {
    throw new Error(`The default voice preset ${defaultPresetId} is missing.`);
  }
  return preset;
}

export function presetChoices(): { name: string; value: string }[] {
  return voicePresets.map((preset) => ({
    name: preset.label,
    value: preset.id,
  }));
}
