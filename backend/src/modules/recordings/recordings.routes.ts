import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { requireAuth, requireCourseRole } from '../../middleware/auth.js';
import {
  createMultipart,
  presignUploadPart,
  completeMultipart,
  abortMultipart,
} from '../storage/s3.js';
import { recordingQueue } from '../../jobs/queue.js';

export const recordingsRouter = Router({ mergeParams: true });

recordingsRouter.use(requireAuth);

// Init: allocate SessionRecording row + S3 multipart upload
recordingsRouter.post(
  '/',
  requireCourseRole('courseId', ['TEACHER']),
  async (req, res, next) => {
    try {
      const { sessionId } = req.params;
      const session = await prisma.courseSession.findUnique({ where: { id: sessionId } });
      if (!session || session.courseId !== req.params.courseId)
        return res.status(404).json({ error: 'session not found' });

      // one recording per session
      const existing = await prisma.sessionRecording.findUnique({ where: { sessionId } });
      if (existing && ['PROCESSING', 'READY'].includes(existing.status))
        return res.status(409).json({ error: 'recording already finalized' });

      const rawKey = `raw/${sessionId}/${Date.now()}.webm`;
      const s3UploadId = await createMultipart(rawKey);

      const recording = existing
        ? await prisma.sessionRecording.update({
            where: { id: existing.id },
            data: {
              status: 'UPLOADING',
              rawKey,
              s3UploadId,
              playbackKey: null,
              durationSec: null,
              errorMessage: null,
            },
          })
        : await prisma.sessionRecording.create({
            data: { sessionId, status: 'UPLOADING', rawKey, s3UploadId },
          });

      await prisma.courseSession.update({
        where: { id: sessionId },
        data: { status: 'LIVE', startedAt: new Date() },
      });

      res.status(201).json({
        recordingId: recording.id,
        rawKey,
        s3UploadId,
      });
    } catch (e) {
      next(e);
    }
  },
);

// Presigned URL for a single part (1-indexed)
recordingsRouter.post(
  '/:recordingId/part-url',
  requireCourseRole('courseId', ['TEACHER']),
  async (req, res, next) => {
    try {
      const { partNumber } = z
        .object({ partNumber: z.number().int().min(1).max(10000) })
        .parse(req.body);
      const recording = await prisma.sessionRecording.findUnique({
        where: { id: req.params.recordingId },
      });
      if (!recording || !recording.rawKey || !recording.s3UploadId)
        return res.status(404).json({ error: 'not found' });
      const url = await presignUploadPart(recording.rawKey, recording.s3UploadId, partNumber);
      res.json({ url, partNumber });
    } catch (e) {
      next(e);
    }
  },
);

// Client reports all parts uploaded → complete S3 multipart → enqueue processing
const completeSchema = z.object({
  parts: z
    .array(z.object({ PartNumber: z.number().int().min(1), ETag: z.string().min(1) }))
    .min(1),
});

recordingsRouter.post(
  '/:recordingId/complete',
  requireCourseRole('courseId', ['TEACHER']),
  async (req, res, next) => {
    try {
      const { parts } = completeSchema.parse(req.body);
      const recording = await prisma.sessionRecording.findUnique({
        where: { id: req.params.recordingId },
      });
      if (!recording || !recording.rawKey)
        return res.status(404).json({ error: 'not found' });

      // Idempotent: if multipart was already completed in a previous call
      // (but enqueue failed), just re-enqueue the processing job.
      if (!recording.s3UploadId) {
        if (recording.status === 'READY') return res.json({ ok: true, recording });
        await recordingQueue.add(
          'process',
          { recordingId: recording.id },
          { jobId: `rec-${recording.id}-${Date.now()}` },
        );
        return res.json({ ok: true, recording });
      }

      await completeMultipart(recording.rawKey, recording.s3UploadId, parts);

      const updated = await prisma.sessionRecording.update({
        where: { id: recording.id },
        data: { status: 'PROCESSING', s3UploadId: null },
      });

      await prisma.courseSession.update({
        where: { id: recording.sessionId },
        data: { status: 'ENDED', endedAt: new Date() },
      });

      await recordingQueue.add(
        'process',
        { recordingId: updated.id },
        { jobId: `rec-${updated.id}` },
      );

      res.json({ ok: true, recording: updated });
    } catch (e) {
      next(e);
    }
  },
);

// Abort — used when the client crashes mid-upload
recordingsRouter.post(
  '/:recordingId/abort',
  requireCourseRole('courseId', ['TEACHER']),
  async (req, res, next) => {
    try {
      const recording = await prisma.sessionRecording.findUnique({
        where: { id: req.params.recordingId },
      });
      if (!recording) return res.status(404).json({ error: 'not found' });
      if (recording.rawKey && recording.s3UploadId)
        await abortMultipart(recording.rawKey, recording.s3UploadId);
      await prisma.sessionRecording.update({
        where: { id: recording.id },
        data: { status: 'FAILED', errorMessage: 'Aborted by teacher', s3UploadId: null },
      });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  },
);

// Save chapters (teacher marks chapters during recording)
const chaptersSchema = z.object({
  chapters: z
    .array(
      z.object({
        timeSec: z.number().int().min(0),
        label: z.string().min(1).max(120),
      }),
    )
    .max(50),
});

recordingsRouter.put(
  '/:recordingId/chapters',
  requireCourseRole('courseId', ['TEACHER']),
  async (req, res, next) => {
    try {
      const { chapters } = chaptersSchema.parse(req.body);
      const recording = await prisma.sessionRecording.update({
        where: { id: req.params.recordingId },
        data: { chapters: chapters.sort((a, b) => a.timeSec - b.timeSec) },
      });
      res.json(recording);
    } catch (e) {
      next(e);
    }
  },
);

// Reset a stuck recording — wipes state and deletes the row so the teacher
// can start a fresh recording. Use this when the recording is stuck in
// UPLOADING/PROCESSING with no raw upload or an uploadable raw file.
recordingsRouter.post(
  '/:recordingId/reset',
  requireCourseRole('courseId', ['TEACHER']),
  async (req, res, next) => {
    try {
      const recording = await prisma.sessionRecording.findUnique({
        where: { id: req.params.recordingId },
      });
      if (!recording) return res.status(404).json({ error: 'not found' });

      // Abort any in-flight multipart upload so S3 storage is released.
      if (recording.rawKey && recording.s3UploadId) {
        try {
          await abortMultipart(recording.rawKey, recording.s3UploadId);
        } catch {}
      }
      await prisma.sessionRecording.delete({ where: { id: recording.id } });
      // Also revert the session back to SCHEDULED so the "Start recording"
      // button is available again.
      await prisma.courseSession.update({
        where: { id: recording.sessionId },
        data: { status: 'SCHEDULED', startedAt: null, endedAt: null },
      });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  },
);

// Retry a failed recording — just re-enqueues the process job if raw exists
recordingsRouter.post(
  '/:recordingId/retry',
  requireCourseRole('courseId', ['TEACHER']),
  async (req, res, next) => {
    try {
      const recording = await prisma.sessionRecording.findUnique({
        where: { id: req.params.recordingId },
      });
      if (!recording) return res.status(404).json({ error: 'not found' });
      if (!recording.rawKey)
        return res.status(400).json({ error: 'no raw upload to retry' });
      await prisma.sessionRecording.update({
        where: { id: recording.id },
        data: { status: 'PROCESSING', errorMessage: null },
      });
      await recordingQueue.add(
        'process',
        { recordingId: recording.id },
        { jobId: `rec-${recording.id}-retry-${Date.now()}` },
      );
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  },
);

// Poll status
recordingsRouter.get(
  '/:recordingId',
  requireCourseRole('courseId', ['TEACHER', 'STUDENT']),
  async (req, res, next) => {
    try {
      const recording = await prisma.sessionRecording.findUnique({
        where: { id: req.params.recordingId },
      });
      if (!recording) return res.status(404).json({ error: 'not found' });
      res.json(recording);
    } catch (e) {
      next(e);
    }
  },
);
