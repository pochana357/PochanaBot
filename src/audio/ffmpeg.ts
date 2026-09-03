import { spawn, spawnSync } from 'node:child_process';
import type { Readable } from 'node:stream';
import {
  createAudioResource,
  StreamType,
  type AudioResource,
} from '@discordjs/voice';
import type { Track } from '../media.js';

export type AudioPipeline = {
  resource: AudioResource<Track>;
  dispose(): void;
};

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

export function createAudioPipeline(
  source: Readable,
  track: Track,
  onError: (error: Error) => void,
): AudioPipeline {
  let ffmpegCommand: string;
  try {
    resolvedFfmpegCommand ??= findFfmpegCommand();
    ffmpegCommand = resolvedFfmpegCommand;
  } catch (error) {
    source.destroy();
    throw error;
  }

  const child = spawn(
    ffmpegCommand,
    [
      // Output headerless PCM: interleaved stereo, 48 kHz, signed 16-bit
      // little-endian samples, as expected by Discord's Opus encoder.
      '-hide_banner',
      '-loglevel',
      'warning',
      '-i',
      'pipe:0',
      '-map',
      '0:a:0',
      '-vn',
      '-ac',
      '2',
      '-ar',
      '48000',
      '-f',
      's16le',
      'pipe:1',
    ],
    {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );

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
    if (code && !disposed) {
      report(
        new Error(
          `FFmpeg exited with code ${code}.${stderr.trim() ? ` ${stderr.trim()}` : ''}`,
        ),
      );
    }
  });

  source.pipe(child.stdin);

  return {
    resource: createAudioResource(child.stdout, {
      inputType: StreamType.Raw,
      metadata: track,
    }),
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
