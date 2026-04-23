import 'dotenv/config';
import '../lib/bigint.js';
import { Worker } from 'bullmq';
import { redis } from '../lib/redis.js';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { extractAudio, transcribe } from './transcribe.js';
import { summarize, generateAutoChapters } from './llm.js';
import { Bucket, s3, PutObjectCommand } from '../modules/storage/s3.js';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { pipeline } from 'node:stream/promises';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function resolveBinary(staticPath: string | null | undefined, name: string): string {
  // Prefer env override, then the static package, then fall back to PATH.
  const envKey = name === 'ffmpeg' ? 'FFMPEG_PATH' : 'FFPROBE_PATH';
  const fromEnv = process.env[envKey];
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  if (staticPath && fs.existsSync(staticPath)) return staticPath;
  try {
    const sys = execSync(`command -v ${name}`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    if (sys && fs.existsSync(sys)) {
      logger.warn({ binary: name, path: sys }, 'falling back to system binary');
      return sys;
    }
  } catch {}
  throw new Error(
    `${name} not found — install system ${name} (brew install ffmpeg) or run "pnpm approve-builds"`,
  );
}

const ffmpegBin = resolveBinary(ffmpegPath as unknown as string, 'ffmpeg');
const ffprobeBin = resolveBinary(ffprobeStatic?.path, 'ffprobe');
ffmpeg.setFfmpegPath(ffmpegBin);
ffmpeg.setFfprobePath(ffprobeBin);
logger.info({ ffmpeg: ffmpegBin, ffprobe: ffprobeBin }, 'ffmpeg binaries resolved');

async function downloadToFile(key: string, dest: string) {
  const obj = await s3.send(new GetObjectCommand({ Bucket, Key: key }));
  const body = obj.Body as NodeJS.ReadableStream;
  await pipeline(body, fs.createWriteStream(dest));
}

async function uploadFile(key: string, file: string, contentType: string) {
  const buf = fs.readFileSync(file);
  await s3.send(
    new PutObjectCommand({ Bucket, Key: key, Body: buf, ContentType: contentType }),
  );
  return buf.length;
}

function probeDuration(file: string): Promise<number> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(file, (err, data) => {
      if (err) {
        logger.warn({ err: err.message, file }, 'ffprobe failed, using 0');
        return resolve(0);
      }
      const d = Number(data?.format?.duration ?? 0);
      resolve(Number.isFinite(d) ? Math.round(d) : 0);
    });
  });
}

/**
 * Transcode webm → mp4. Pass output args as separate tokens so fluent-ffmpeg
 * never splits on whitespace inside filter expressions. The scale filter caps
 * at 1080p but only when we have a video stream with known dimensions.
 */
function transcode(input: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const stderrChunks: string[] = [];
    let lastProgressLog = 0;
    const cmd = ffmpeg(input)
      // Regenerate PTS so MediaRecorder's quirky timestamps don't confuse players.
      .inputOptions(['-fflags', '+genpts'])
      .videoCodec('libx264')
      .audioCodec('aac')
      .outputOptions([
        // Explicitly map video + audio — without -map, some FFmpeg builds
        // silently drop the audio stream if input has unusual layout.
        // `?` on the audio map means "optional": don't fail if no audio exists.
        '-map',
        '0:v:0',
        '-map',
        '0:a:0?',
        '-preset',
        process.env.FFMPEG_PRESET ?? 'ultrafast',
        '-crf',
        process.env.FFMPEG_CRF ?? '28',
        // Force constant 30 fps at the OUTPUT level — avoids VFR playback
        // stalls without touching audio timing (the old `-vf fps=30` filter
        // would sometimes throw audio sync off).
        '-r',
        '30',
        '-vsync',
        'cfr',
        '-vf',
        "scale='trunc(min(iw\\,1920)/2)*2':'trunc(min(ih\\,1080)/2)*2'",
        '-g',
        '60',
        // Resample audio to fix any sync drift introduced by VFR→CFR.
        '-af',
        'aresample=async=1000',
        '-movflags',
        '+faststart',
        '-b:a',
        '128k',
        '-ar',
        '48000',
        '-ac',
        '2',
        '-pix_fmt',
        'yuv420p',
        '-max_muxing_queue_size',
        '1024',
        '-threads',
        '0',
      ])
      .on('start', (line) => logger.info({ cmd: line }, 'ffmpeg start'))
      .on('progress', (p) => {
        // Log progress at most every 5 s so we don't spam.
        const now = Date.now();
        if (now - lastProgressLog > 5000) {
          lastProgressLog = now;
          logger.info(
            {
              timemark: p.timemark,
              fps: p.currentFps,
              percent: p.percent?.toFixed(1),
            },
            'ffmpeg progress',
          );
        }
      })
      .on('stderr', (line) => {
        stderrChunks.push(line);
        if (stderrChunks.length > 40) stderrChunks.shift();
      })
      .on('end', () => resolve())
      .on('error', (err) => {
        const tail = stderrChunks.slice(-8).join(' | ');
        const msg = `${err.message}${tail ? ` :: ${tail}` : ''}`;
        reject(new Error(msg));
      })
      .save(output);
    return cmd;
  });
}

/**
 * Fallback transcode without scale filter — tolerates inputs where
 * dimensions are unknown or unusual.
 */
function transcodeSimple(input: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const stderrChunks: string[] = [];
    ffmpeg(input)
      .inputOptions(['-fflags', '+genpts'])
      .outputOptions([
        '-map',
        '0:v:0',
        '-map',
        '0:a:0?',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-crf',
        '28',
        '-r',
        '30',
        '-vsync',
        'cfr',
        '-g',
        '60',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-ar',
        '48000',
        '-ac',
        '2',
        '-af',
        'aresample=async=1000',
        '-movflags',
        '+faststart',
        '-pix_fmt',
        'yuv420p',
        '-max_muxing_queue_size',
        '1024',
        '-threads',
        '0',
      ])
      .on('stderr', (line) => {
        stderrChunks.push(line);
        if (stderrChunks.length > 40) stderrChunks.shift();
      })
      .on('end', () => resolve())
      .on('error', (err) => {
        const tail = stderrChunks.slice(-8).join(' | ');
        reject(new Error(`${err.message}${tail ? ` :: ${tail}` : ''}`));
      })
      .save(output);
  });
}

function extractThumbnail(input: string, output: string, atSec: number) {
  return new Promise<void>((resolve, reject) => {
    ffmpeg(input)
      .seekInput(Math.max(0, atSec))
      .outputOptions(['-frames:v', '1', '-q:v', '3', '-vf', 'scale=640:-2'])
      .on('end', () => resolve())
      .on('error', reject)
      .save(output);
  });
}

export const recordingWorker = new Worker(
  'recording-process',
  async (job) => {
    const { recordingId } = job.data as { recordingId: string };
    const recording = await prisma.sessionRecording.findUnique({ where: { id: recordingId } });
    if (!recording || !recording.rawKey) throw new Error('recording not found');

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-'));
    const rawFile = path.join(tmp, 'in.webm');
    const mp4File = path.join(tmp, 'out.mp4');
    const thumbFile = path.join(tmp, 'thumb.jpg');
    const audioFile = path.join(tmp, 'audio.mp3');

    try {
      await downloadToFile(recording.rawKey, rawFile);
      const stat = fs.statSync(rawFile);
      if (stat.size < 1024) {
        throw new Error(
          `raw upload is only ${stat.size} bytes — the recording was too short or no chunks reached storage`,
        );
      }
      logger.info({ recordingId, rawBytes: stat.size }, 'downloaded raw');

      // NOTE: we DON'T ffprobe the raw webm anymore — MediaRecorder's container
      // duration is unreliable. We probe the transcoded mp4 instead, below.

      // ─── Run video pipeline + transcription PIPELINE in parallel ───
      const videoTask = (async () => {
        try {
          await transcode(rawFile, mp4File);
        } catch (e: any) {
          logger.warn({ err: e.message }, 'primary transcode failed, trying simple');
          await transcodeSimple(rawFile, mp4File);
        }

        // Probe the *transcoded* mp4 for the real duration (cleaned up by
        // ffmpeg's CFR + genpts pass).
        const duration = await probeDuration(mp4File);
        logger.info({ recordingId: recording.id, duration }, 'probed mp4 duration');

        const thumbAt = duration > 0 ? Math.min(5, duration * 0.1) : 0;
        let thumbnailKey: string | null = null;
        try {
          await extractThumbnail(mp4File, thumbFile, thumbAt);
          thumbnailKey = `processed/${recording.sessionId}/thumb.jpg`;
          await uploadFile(thumbnailKey, thumbFile, 'image/jpeg');
        } catch (e) {
          logger.warn({ err: String(e) }, 'thumbnail extraction failed — continuing');
        }

        const playbackKey = `processed/${recording.sessionId}/playback.mp4`;
        const sizeBytes = await uploadFile(playbackKey, mp4File, 'video/mp4');

        await prisma.sessionRecording.update({
          where: { id: recording.id },
          data: {
            status: 'READY',
            playbackKey,
            thumbnailKey,
            durationSec: duration,
            sizeBytes: BigInt(sizeBytes),
            errorMessage: null,
          },
        });
        logger.info({ recordingId: recording.id, duration }, 'recording READY (video)');
      })();

      const transcriptTask = (async () => {
        try {
          await extractAudio(rawFile, audioFile);
          const segs = await transcribe(audioFile);
          if (segs && segs.length > 0) {
            logger.info(
              { recordingId: recording.id, segments: segs.length },
              'transcribed',
            );
            await prisma.sessionRecording.update({
              where: { id: recording.id },
              data: { transcript: segs },
            });
            return segs;
          }
          return null;
        } catch (e) {
          logger.warn({ err: String(e) }, 'transcription failed — video still playable');
          return null;
        }
      })();

      // Wait for both video + transcript tracks.
      const [, segs] = await Promise.all([videoTask, transcriptTask]);

      // Track C: LLM post-process, once we have a transcript.
      if (segs && segs.length > 0) {
        const flatText = segs.map((s) => s.text).join(' ');
        const hasManualChapters =
          Array.isArray(recording.chapters) && (recording.chapters as any[]).length > 0;

        const [summary, autoChapters] = await Promise.all([
          summarize(flatText).catch((e) => {
            logger.warn({ err: String(e) }, 'summary step failed');
            return null;
          }),
          hasManualChapters
            ? Promise.resolve(null)
            : generateAutoChapters(segs).catch((e) => {
                logger.warn({ err: String(e) }, 'auto-chapter step failed');
                return null;
              }),
        ]);

        if (summary || autoChapters) {
          await prisma.sessionRecording.update({
            where: { id: recording.id },
            data: {
              ...(summary ? { summary } : {}),
              ...(autoChapters ? { autoChapters } : {}),
            },
          });
          logger.info(
            {
              recordingId: recording.id,
              hasSummary: !!summary,
              chapters: autoChapters?.length ?? 0,
            },
            'post-processing complete',
          );
        }
      }
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      logger.error({ recordingId: recording.id, err: msg }, 'worker failed');
      await prisma.sessionRecording.update({
        where: { id: recording.id },
        data: { status: 'FAILED', errorMessage: msg.slice(0, 500) },
      });
      throw err;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  },
  { connection: redis, concurrency: 1 },
);

recordingWorker.on('ready', () => logger.info('worker ready'));
recordingWorker.on('failed', (job, err) =>
  logger.error({ jobId: job?.id, err: err.message }, 'job failed'),
);

/**
 * Auto-recovery on startup: any recording that's been stuck in UPLOADING or
 * PROCESSING for more than 5 minutes is either re-enqueued (if the raw file
 * exists) or marked FAILED (if it doesn't). This means a worker restart
 * heals the system without a human running scripts.
 */
async function recoverStuckOnStartup() {
  try {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
    const stuck = await prisma.sessionRecording.findMany({
      where: {
        status: { in: ['UPLOADING', 'PROCESSING'] },
        updatedAt: { lt: fiveMinAgo },
      },
      select: { id: true, status: true, rawKey: true, sessionId: true },
    });
    if (stuck.length === 0) return;
    logger.info({ count: stuck.length }, 'found stuck recordings, recovering');
    for (const r of stuck) {
      if (!r.rawKey) {
        // No raw file → can't process. Mark FAILED so teacher can record fresh.
        await prisma.sessionRecording.update({
          where: { id: r.id },
          data: {
            status: 'FAILED',
            errorMessage: `recovered from stuck ${r.status} state — no raw upload`,
          },
        });
        logger.info({ recordingId: r.id }, 'marked FAILED (no raw)');
      } else {
        // Raw exists → re-enqueue. Worker will pick up.
        await prisma.sessionRecording.update({
          where: { id: r.id },
          data: { status: 'PROCESSING', errorMessage: null },
        });
        await recordingQueue.add(
          'process',
          { recordingId: r.id },
          { jobId: `rec-${r.id}-recover-${Date.now()}` },
        );
        logger.info({ recordingId: r.id }, 're-enqueued stuck recording');
      }
    }
  } catch (e) {
    logger.error({ err: String(e) }, 'startup recovery failed');
  }
}

// Imports needed for recovery
import { recordingQueue } from './queue.js';

// Run recovery shortly after the worker boots — don't block listening.
setTimeout(() => void recoverStuckOnStartup(), 1500);
