import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../lib/logger.js';
import ffmpeg from 'fluent-ffmpeg';

export type TranscriptSegment = { startSec: number; endSec: number; text: string };

/**
 * Extract audio as a small mp3 from a video file. Smaller payload = faster ASR
 * and stays under the 25 MB cap that most hosted Whisper providers enforce.
 */
export function extractAudio(input: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(input)
      .noVideo()
      .audioCodec('libmp3lame')
      .audioBitrate('64k')
      .audioChannels(1)
      .audioFrequency(16000)
      .on('end', () => resolve())
      .on('error', reject)
      .save(output);
  });
}

/**
 * Call any Whisper-compatible speech-to-text endpoint. Works with:
 *   - Groq        https://api.groq.com/openai/v1          whisper-large-v3
 *   - Deepgram    https://api.deepgram.com/v1 (compat)    nova-2
 *   - Local       http://whisper:8000/v1                  Systran/faster-whisper-small
 *   - anything that implements POST /audio/transcriptions in OpenAI format
 *
 * Env:
 *   WHISPER_API_KEY       required (put any non-empty value for keyless local servers)
 *   WHISPER_API_BASE_URL  e.g. https://api.groq.com/openai/v1
 *   WHISPER_MODEL         e.g. whisper-large-v3
 *   WHISPER_MAX_UPLOAD_MB 25 (hosted) or 500 (local); audio bigger than this is skipped
 *
 * Returns `null` if no key is configured so the worker can continue without a transcript.
 */
export async function transcribe(
  audioFile: string,
): Promise<TranscriptSegment[] | null> {
  const key = process.env.WHISPER_API_KEY;
  if (!key) {
    logger.info('no WHISPER_API_KEY — skipping transcription');
    return null;
  }
  const baseUrl = (
    process.env.WHISPER_API_BASE_URL ?? 'https://api.groq.com/openai/v1'
  ).replace(/\/+$/, '');
  const model = process.env.WHISPER_MODEL ?? 'whisper-large-v3';

  const stat = fs.statSync(audioFile);
  const maxMB = Number(process.env.WHISPER_MAX_UPLOAD_MB ?? 25);
  const isLocal =
    /localhost|127\.0\.0\.1|host\.docker\.internal/i.test(baseUrl) ||
    baseUrl.startsWith('http://whisper:');
  if (!isLocal && stat.size > maxMB * 1024 * 1024) {
    logger.warn(
      { sizeMB: (stat.size / 1024 / 1024).toFixed(1), maxMB, baseUrl },
      'audio exceeds provider cap; skipping transcription',
    );
    return null;
  }

  const form = new FormData();
  form.append(
    'file',
    new Blob([fs.readFileSync(audioFile)], { type: 'audio/mpeg' }),
    path.basename(audioFile),
  );
  form.append('model', model);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'segment');

  const url = `${baseUrl}/audio/transcriptions`;
  logger.info(
    { url, model, sizeMB: (stat.size / 1024 / 1024).toFixed(1) },
    'calling whisper',
  );
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Whisper ${res.status}: ${txt.slice(0, 300)}`);
  }
  const data = (await res.json()) as any;
  const segments: TranscriptSegment[] = (data.segments ?? []).map((s: any) => ({
    startSec: Math.round((s.start ?? 0) * 100) / 100,
    endSec: Math.round((s.end ?? 0) * 100) / 100,
    text: String(s.text ?? '').trim(),
  }));
  return segments;
}

