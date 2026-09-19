export interface VoicePreferenceStore {
  get(userId: string): string | undefined;
  set(userId: string, presetId: string): void;
}

/**
 * Preferences live only for the lifetime of the process, matching how playback
 * queues behave. Swap in a persistent implementation without touching callers.
 */
export class InMemoryVoicePreferenceStore implements VoicePreferenceStore {
  readonly #preferences = new Map<string, string>();

  get(userId: string): string | undefined {
    return this.#preferences.get(userId);
  }

  set(userId: string, presetId: string): void {
    this.#preferences.set(userId, presetId);
  }
}
