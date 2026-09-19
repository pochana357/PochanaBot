export type TtsEngineId = 'edge' | 'fish';

export type TtsVoicePreset = {
  /** Slash-command choice value; stable, because preferences are keyed on it. */
  readonly id: string;
  readonly label: string;
  readonly engine: TtsEngineId;
  /** Edge voice name (`en-US-AriaNeural`) or Fish `reference_id`. */
  readonly voice: string;
  readonly language: string;
  /** 1 is the engine default; below 1 is slower. */
  readonly speed?: number;
  /** Decibel offset; 0 is the engine default. */
  readonly volume?: number;
};

export type TtsAudio = {
  /**
   * A complete, decodable container. Engines buffer rather than stream so a
   * response that fails to demux is reported before any of it is spoken.
   */
  readonly data: Buffer;
  readonly contentType: string;
};

export interface TtsEngine {
  readonly id: TtsEngineId;
  synthesize(
    text: string,
    preset: TtsVoicePreset,
    signal: AbortSignal,
  ): Promise<TtsAudio>;
}

/** A failure the requesting user should see verbatim. */
export class TtsError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TtsError';
  }
}
