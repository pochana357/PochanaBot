import { spawn, spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import {
  createAudioResource,
  StreamType,
  type AudioResource,
} from '@discordjs/voice';

export type AudioPipeline<T extends object> = {
  resource: AudioResource<T>;
  dispose(): void;
};

export type TranscodeOptions = {
  /** Linear gain; 1 leaves the source untouched, 0.5 halves the amplitude. */
  volume?: number;
};

// 48 kHz, stereo, signed 16-bit.
const PCM_BYTES_PER_SECOND = 48_000 * 2 * 2;
// A duration no valid request can reach, rather than the shortest one that
// usually fits. Three hundred characters -- the /tts limit -- is three hundred
// syllables in Korean or Japanese and runs well past a minute, so a
// thirty-second ceiling would reject legitimate speech after paying to
// synthesize it.
export const MAX_DECODED_SECONDS = 150;
const MAX_DECODED_BYTES = MAX_DECODED_SECONDS * PCM_BYTES_PER_SECOND;

const FFMPEG_COMMANDS = ['ffmpeg', './ffmpeg'] as const;
let resolvedFfmpegCommand: string | undefined;

export function findFfmpegCommand(
  probe: (command: string) => boolean = probeFfmpeg,
): string {
  for (const command of FFMPEG_COMMANDS) {
    if (probe(command)) return command;
  }
  throw new Error('FFmpeg was not found on the system PATH or at ./ffmpeg.');
}

function probeFfmpeg(command: string): boolean {
  const result = spawnSync(command, ['-version'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  return !result.error && result.status === 0;
}

function requireFfmpegCommand(): string {
  resolvedFfmpegCommand ??= findFfmpegCommand();
  return resolvedFfmpegCommand;
}

// Output headerless PCM: interleaved stereo, 48 kHz, signed 16-bit
// little-endian samples, as expected by Discord's Opus encoder.
function transcodeArgs({ volume }: TranscodeOptions = {}): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-i',
    'pipe:0',
    '-map',
    '0:a:0',
    '-vn',
    ...(volume === undefined || volume === 1
      ? []
      : ['-af', `volume=${volume}`]),
    '-ac',
    '2',
    '-ar',
    '48000',
    '-f',
    's16le',
    'pipe:1',
  ];
}

export function createAudioPipeline<T extends object>(
  source: Readable,
  metadata: T,
  onError: (error: Error) => void,
  options: TranscodeOptions = {},
): AudioPipeline<T> {
  let ffmpegCommand: string;
  try {
    ffmpegCommand = requireFfmpegCommand();
  } catch (error) {
    source.destroy();
    throw error;
  }

  const child = spawn(ffmpegCommand, transcodeArgs(options), {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let disposed = false;
  let stderr = '';
  const report = (error: Error) => {
    if (!disposed) onError(error);
  };

  source.once('error', (error) => {
    child.stdin.destroy(error);
    report(error);
  });
  child.stdin.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') report(error);
  });
  child.once('error', report);
  child.stderr.on('data', (chunk: Buffer) => {
    // Retain a useful diagnostic tail without buffering unbounded FFmpeg output.
    stderr = `${stderr}${chunk.toString()}`.slice(-4000);
  });
  child.once('close', (code) => {
    if (code && !disposed) report(new Error(ffmpegFailure(code, stderr)));
  });

  source.pipe(child.stdin);

  return {
    // createAudioResource widens metadata to `T extends null ? null : T`;
    // metadata is constrained to an object, so those coincide here.
    resource: createAudioResource(child.stdout, {
      inputType: StreamType.Raw,
      metadata,
    }) as AudioResource<T>,
    dispose() {
      if (disposed) return;
      disposed = true;
      source.destroy();
      child.stdin.destroy();
      child.stdout.destroy();
      if (child.exitCode === null) child.kill();
    },
  };
}

function ffmpegFailure(code: number, stderr: string): string {
  return `FFmpeg exited with code ${code}.${stderr.trim() ? ` ${stderr.trim()}` : ''}`;
}

/**
 * Decodes a complete container to PCM, rejecting if it cannot be demuxed. This
 * is how a response that is well-formed HTTP but malformed audio is caught
 * before playback is acknowledged, rather than failing moments afterwards.
 */
export function decodeToPcm(
  data: Buffer,
  signal: AbortSignal,
  options: TranscodeOptions = {},
): Promise<Buffer> {
  const ffmpegCommand = requireFfmpegCommand();
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(ffmpegCommand, transcodeArgs(options), {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = '';
    let settled = false;

    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
      if (child.exitCode === null) child.kill();
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    function onAbort(): void {
      fail(new Error('Audio decoding was cancelled.'));
    }

    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });

    child.once('error', fail);
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') fail(error);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-4000);
    });
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_DECODED_BYTES) {
        fail(new Error('The decoded audio was unexpectedly long.'));
        return;
      }
      chunks.push(chunk);
    });
    child.once('close', (code) => {
      if (settled) return;
      if (code) {
        fail(new Error(ffmpegFailure(code, stderr)));
        return;
      }
      if (size === 0) {
        fail(new Error('The audio contained no decodable samples.'));
        return;
      }
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks));
    });

    child.stdin.end(data);
  });
}

/** Plays already-decoded PCM, so no transcoder runs during playback. */
export function createPcmPipeline<T extends object>(
  pcm: Buffer,
  metadata: T,
): AudioPipeline<T> {
  const source = Readable.from(pcm);
  return {
    resource: createAudioResource(source, {
      inputType: StreamType.Raw,
      metadata,
    }) as AudioResource<T>,
    dispose() {
      source.destroy();
    },
  };
}
