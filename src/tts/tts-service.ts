import { defaultPreset, findPreset } from './presets.js';
import {
  TtsError,
  type TtsAudio,
  type TtsEngine,
  type TtsVoicePreset,
} from './tts.js';
import type { VoicePreferenceStore } from './voice-preferences.js';

// Matches Fish's chunk_length, and keeps a single utterance short enough that it
// never delays queued music for long.
export const MAX_TTS_TEXT_LENGTH = 300;

export interface SpeechSynthesizer {
  synthesize(
    text: string,
    preset: TtsVoicePreset,
    signal: AbortSignal,
  ): Promise<TtsAudio>;
}

export class TtsService implements SpeechSynthesizer {
  readonly #engines: ReadonlyMap<string, TtsEngine>;

  constructor(
    engines: readonly TtsEngine[],
    private readonly preferences: VoicePreferenceStore,
  ) {
    this.#engines = new Map(engines.map((engine) => [engine.id, engine]));
  }

  presetFor(userId: string): TtsVoicePreset {
    const preferred = this.preferences.get(userId);
    return (preferred ? findPreset(preferred) : undefined) || defaultPreset();
  }

  selectPreset(userId: string, presetId: string): TtsVoicePreset {
    const preset = findPreset(presetId);
    if (!preset) throw new TtsError('That voice preset does not exist.');
    this.preferences.set(userId, preset.id);
    return preset;
  }

  /** Throws TtsError for anything the requesting user should see verbatim. */
  static normalizeText(text: string): string {
    const normalized = text.trim();
    if (!normalized) throw new TtsError('Provide some text to speak.');
    if (normalized.length > MAX_TTS_TEXT_LENGTH) {
      throw new TtsError(
        `Keep the message under ${MAX_TTS_TEXT_LENGTH} characters.`,
      );
    }
    return normalized;
  }

  async synthesize(
    text: string,
    preset: TtsVoicePreset,
    signal: AbortSignal,
  ): Promise<TtsAudio> {
    const engine = this.#engines.get(preset.engine);
    if (!engine) {
      throw new TtsError(`The ${preset.engine} voice engine is unavailable.`);
    }
    return engine.synthesize(text, preset, signal);
  }
}
