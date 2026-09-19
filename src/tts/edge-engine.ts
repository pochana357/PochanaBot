import { createHash, randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import {
  TtsError,
  type TtsAudio,
  type TtsEngine,
  type TtsVoicePreset,
} from './tts.js';

// Microsoft's Edge "read aloud" endpoint. This is an undocumented protocol; the
// constants below mirror what the browser sends and must move together.
const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const WSS_ENDPOINT =
  'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
// The service enforces a minimum browser version through the User-Agent below,
// and answers anything older with a bare 403 that looks exactly like a bad
// token. Measured 2026-09-19: Edg/131 is refused, Edg/132 is accepted. Keep
// these tracking upstream edge-tts rather than sitting on the floor.
const CHROMIUM_FULL_VERSION = '143.0.3650.75';
const CHROMIUM_MAJOR_VERSION = '143';
const SEC_MS_GEC_VERSION = `1-${CHROMIUM_FULL_VERSION}`;
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
const SYNTHESIS_TIMEOUT_MS = 30_000;

// Windows FILETIME epoch (1601-01-01) expressed as an offset from the Unix epoch.
const WINDOWS_EPOCH_OFFSET_SECONDS = 11_644_473_600;
const TOKEN_WINDOW_SECONDS = 300;

const WSS_HEADERS = {
  Pragma: 'no-cache',
  'Cache-Control': 'no-cache',
  Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR_VERSION}.0.0.0`,
};

/**
 * The anti-abuse token the endpoint has required since late 2024: the SHA-256 of
 * the Windows FILETIME, floored to a five-minute window, concatenated with the
 * trusted client token. A token outside the current window is rejected with 403.
 */
export function secMsGecToken(nowMs: number = Date.now()): string {
  const seconds = Math.floor(nowMs / 1000) + WINDOWS_EPOCH_OFFSET_SECONDS;
  const windowStart = seconds - (seconds % TOKEN_WINDOW_SECONDS);
  // FILETIME counts 100 ns intervals, which overflows Number.MAX_SAFE_INTEGER.
  const ticks = BigInt(windowStart) * 10_000_000n;
  return createHash('sha256')
    .update(`${ticks}${TRUSTED_CLIENT_TOKEN}`, 'ascii')
    .digest('hex')
    .toUpperCase();
}

export type EdgeFrame = {
  headers: ReadonlyMap<string, string>;
  payload: Buffer;
};

function parseHeaderBlock(block: string): Map<string, string> {
  const headers = new Map<string, string>();
  for (const line of block.split('\r\n')) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    headers.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return headers;
}

/**
 * Binary frames are a 2-byte big-endian header length, that many bytes of
 * `Key:Value` headers, then the audio slice. The envelope must be stripped
 * before payloads are concatenated, or the resulting MP3 is corrupt.
 */
export function parseBinaryFrame(frame: Buffer): EdgeFrame {
  if (frame.length < 2) {
    throw new TtsError('The speech service sent a frame without a header.');
  }
  const headerLength = frame.readUInt16BE(0);
  if (headerLength + 2 > frame.length) {
    throw new TtsError('The speech service sent a frame with a bad header.');
  }
  return {
    headers: parseHeaderBlock(frame.subarray(2, 2 + headerLength).toString()),
    payload: frame.subarray(2 + headerLength),
  };
}

export function parseTextFrame(frame: string): EdgeFrame {
  const separator = frame.indexOf('\r\n\r\n');
  return {
    headers: parseHeaderBlock(
      separator === -1 ? frame : frame.slice(0, separator),
    ),
    payload: Buffer.alloc(0),
  };
}

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function ratePercent(speed: number | undefined): string {
  const percent = Math.round(((speed ?? 1) - 1) * 100);
  return `${percent >= 0 ? '+' : ''}${percent}%`;
}

function volumePercent(decibels: number | undefined): string {
  // Presets carry decibels because that is Fish's unit; Edge wants a percentage
  // of the default amplitude.
  const ratio = 10 ** ((decibels ?? 0) / 20) - 1;
  const percent = Math.max(-100, Math.min(100, Math.round(ratio * 100)));
  return `${percent >= 0 ? '+' : ''}${percent}%`;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

export function edgeTimestamp(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${DAYS[now.getUTCDay()]} ${MONTHS[now.getUTCMonth()]} ` +
    `${pad(now.getUTCDate())} ${now.getUTCFullYear()} ` +
    `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())} ` +
    'GMT+0000 (Coordinated Universal Time)'
  );
}

export function buildSsml(text: string, preset: TtsVoicePreset): string {
  return (
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
    `<voice name='${preset.voice}'>` +
    `<prosody pitch='+0Hz' rate='${ratePercent(preset.speed)}' volume='${volumePercent(preset.volume)}'>` +
    escapeXml(text) +
    `</prosody></voice></speak>`
  );
}

function configMessage(): string {
  return (
    `X-Timestamp:${edgeTimestamp()}\r\n` +
    'Content-Type:application/json; charset=utf-8\r\n' +
    'Path:speech.config\r\n\r\n' +
    '{"context":{"synthesis":{"audio":{"metadataoptions":{' +
    '"sentenceBoundaryEnabled":false,"wordBoundaryEnabled":false},' +
    `"outputFormat":"${OUTPUT_FORMAT}"` +
    '}}}}\r\n'
  );
}

function ssmlMessage(requestId: string, ssml: string): string {
  return (
    `X-RequestId:${requestId}\r\n` +
    'Content-Type:application/ssml+xml\r\n' +
    // The trailing Z is what Edge itself sends; the service expects it.
    `X-Timestamp:${edgeTimestamp()}Z\r\n` +
    'Path:ssml\r\n\r\n' +
    ssml
  );
}

function buildUrl(): string {
  const url = new URL(WSS_ENDPOINT);
  url.searchParams.set('TrustedClientToken', TRUSTED_CLIENT_TOKEN);
  url.searchParams.set('Sec-MS-GEC', secMsGecToken());
  // Only the shape of this is checked, not the version: a four-part `1-W.X.Y.Z`
  // is required, while `1-143` or a bare `143.0.3650.75` is refused.
  url.searchParams.set('Sec-MS-GEC-Version', SEC_MS_GEC_VERSION);
  url.searchParams.set('ConnectionId', randomUUID().replaceAll('-', ''));
  return url.toString();
}

export class EdgeTtsEngine implements TtsEngine {
  readonly id = 'edge' as const;

  synthesize(
    text: string,
    preset: TtsVoicePreset,
    signal: AbortSignal,
  ): Promise<TtsAudio> {
    return new Promise<TtsAudio>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const requestId = randomUUID().replaceAll('-', '');
      const socket = new WebSocket(buildUrl(), { headers: WSS_HEADERS });
      let settled = false;

      const timer = setTimeout(() => {
        fail(new TtsError('The speech service timed out.'));
      }, SYNTHESIS_TIMEOUT_MS);
      timer.unref();

      const onAbort = () => {
        fail(new TtsError('Speech synthesis was cancelled.'));
      };

      function cleanup(): void {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        socket.removeAllListeners();
        // Terminating mid-handshake makes ws emit; without a listener Node
        // would rethrow it as an unhandled 'error' event.
        socket.on('error', () => {});
        if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
      }

      function fail(error: Error): void {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      }

      function succeed(audio: TtsAudio): void {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(audio);
      }

      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });

      socket.on('open', () => {
        try {
          socket.send(configMessage());
          socket.send(ssmlMessage(requestId, buildSsml(text, preset)));
        } catch (error) {
          fail(
            new TtsError('The speech request could not be sent.', {
              cause: error,
            }),
          );
        }
      });

      socket.on('message', (data: Buffer, isBinary: boolean) => {
        try {
          if (isBinary) {
            const frame = parseBinaryFrame(data);
            if (frame.headers.get('Path') === 'audio') {
              chunks.push(frame.payload);
            }
            return;
          }
          const path = parseTextFrame(data.toString()).headers.get('Path');
          if (path !== 'turn.end') return;
          const audio = Buffer.concat(chunks);
          if (audio.length === 0) {
            fail(new TtsError('The speech service returned no audio.'));
            return;
          }
          succeed({ data: audio, contentType: 'audio/mpeg' });
        } catch (error) {
          fail(
            error instanceof TtsError
              ? error
              : new TtsError('The speech response could not be read.', {
                  cause: error,
                }),
          );
        }
      });

      socket.on('unexpected-response', (_request, response) => {
        fail(
          new TtsError(
            response.statusCode === 403
              ? 'The Edge speech service rejected the request. Its pinned browser version is probably below the minimum it now accepts.'
              : `The Edge speech service returned HTTP ${response.statusCode}.`,
          ),
        );
      });

      socket.on('error', (error) => {
        fail(
          new TtsError('The Edge speech service could not be reached.', {
            cause: error,
          }),
        );
      });

      socket.on('close', () => {
        fail(new TtsError('The speech connection closed before it finished.'));
      });
    });
  }
}
