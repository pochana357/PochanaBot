import {
  TtsError,
  type TtsAudio,
  type TtsEngine,
  type TtsVoicePreset,
} from './tts.js';

const API_BASE = 'https://api.fish.audio';
const REQUEST_TIMEOUT_MS = 120_000;
export const DEFAULT_FISH_MODEL = 's2.1-pro-free';

export type FishEngineOptions = {
  apiKey?: string;
  model?: string;
  fetchImpl?: typeof fetch;
};

export type FishPayload = {
  text: string;
  reference_id: string;
  format: 'opus';
  sample_rate: number;
  opus_bitrate: number;
  latency: 'normal' | 'balanced';
  temperature: number;
  top_p: number;
  normalize: boolean;
  chunk_length: number;
  prosody: { speed: number; volume: number; normalize_loudness: boolean };
};

/**
 * The model infers language from the text, so no language field is sent. Adding
 * one changes the result, so the shape here is deliberately exact.
 */
export function buildPayload(
  text: string,
  preset: TtsVoicePreset,
): FishPayload {
  return {
    text,
    reference_id: preset.voice,
    format: 'opus',
    sample_rate: 48000,
    opus_bitrate: 32000,
    latency: 'normal',
    temperature: 0.7,
    top_p: 0.7,
    normalize: true,
    chunk_length: 300,
    prosody: {
      speed: preset.speed ?? 1,
      volume: preset.volume ?? 0,
      normalize_loudness: true,
    },
  };
}

export class FishTtsEngine implements TtsEngine {
  readonly id = 'fish' as const;
  readonly #apiKey?: string;
  readonly #model: string;
  readonly #fetch: typeof fetch;

  constructor(options: FishEngineOptions = {}) {
    this.#apiKey = options.apiKey;
    this.#model = options.model || DEFAULT_FISH_MODEL;
    this.#fetch = options.fetchImpl || fetch;
  }

  /** Redacts the key so it cannot reach a log line or a Discord reply. */
  #redact(message: string): string {
    return this.#apiKey
      ? message.replaceAll(this.#apiKey, '[REDACTED]')
      : message;
  }

  /**
   * Redacting only the thrown message is not enough: JsonLogger walks the whole
   * cause chain, including stacks. Rebuild the chain with every string redacted
   * so the key cannot reach a log line through an upstream error.
   */
  #sanitize(error: unknown): unknown {
    if (typeof error === 'string') return this.#redact(error);
    if (!(error instanceof Error)) return error;
    const copy = new Error(this.#redact(error.message));
    copy.name = error.name;
    if (error.stack) copy.stack = this.#redact(error.stack);
    if (error.cause !== undefined) copy.cause = this.#sanitize(error.cause);
    return copy;
  }

  async synthesize(
    text: string,
    preset: TtsVoicePreset,
    signal: AbortSignal,
  ): Promise<TtsAudio> {
    const apiKey = this.#apiKey;
    if (!apiKey) {
      throw new TtsError(
        'Fish voices are unavailable because FISH_API_KEY is not configured.',
      );
    }

    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.#fetch(`${API_BASE}/v1/tts`, {
        method: 'POST',
        // Never let a bearer token follow a redirect to another host.
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          // Fish selects the model with a bare header. Omitting it silently
          // falls back to a paid default.
          model: this.#model,
        },
        body: JSON.stringify(buildPayload(text, preset)),
        signal: AbortSignal.any([signal, timeout]),
      });
    } catch (error) {
      if (signal.aborted) throw new TtsError('Speech synthesis was cancelled.');
      throw new TtsError(
        this.#redact(
          error instanceof Error
            ? `The Fish speech service could not be reached. ${error.message}`
            : 'The Fish speech service could not be reached.',
        ),
        { cause: this.#sanitize(error) },
      );
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new TtsError(
        this.#redact(
          `The Fish speech service returned HTTP ${response.status}.${detail.trim() ? ` ${detail.trim()}` : ''}`,
        ),
      );
    }

    const contentType = response.headers.get('content-type') || '';
    // A JSON or HTML body on a 200 means an error document, not audio.
    if (/json|text\/|html/i.test(contentType)) {
      throw new TtsError(
        this.#redact(
          `The Fish speech service returned ${contentType} instead of audio.`,
        ),
      );
    }

    const data = Buffer.from(await response.arrayBuffer());
    if (data.length === 0) {
      throw new TtsError('The Fish speech service returned no audio.');
    }
    return { data, contentType: contentType || 'audio/opus' };
  }
}
