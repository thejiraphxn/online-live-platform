import { Router } from 'express';
import { prisma } from '../../lib/prisma.js';
import { requireAuth, requireCourseRole } from '../../middleware/auth.js';
import { presignGet } from '../storage/s3.js';

export const playbackRouter = Router({ mergeParams: true });

playbackRouter.use(requireAuth);

playbackRouter.get(
  '/',
  requireCourseRole('courseId', ['TEACHER', 'STUDENT'], { allowPublicRead: true }),
  async (req, res, next) => {
    try {
      const session = await prisma.courseSession.findUnique({
        where: { id: req.params.sessionId },
        include: { recording: true },
      });
      if (!session || session.courseId !== req.params.courseId)
        return res.status(404).json({ error: 'session not found' });
      if (
        !session.recording ||
        session.recording.status !== 'READY' ||
        !session.recording.playbackKey
      ) {
        return res.status(409).json({
          error: 'not ready',
          status: session.recording?.status ?? 'PENDING',
        });
      }
      const [url, thumbnailUrl] = await Promise.all([
        presignGet(session.recording.playbackKey),
        session.recording.thumbnailKey ? presignGet(session.recording.thumbnailKey) : null,
      ]);
      // Prefer manual chapters; fall back to LLM-generated ones.
      const manual = (session.recording.chapters as any[]) ?? [];
      const auto = (session.recording.autoChapters as any[]) ?? [];
      const chapters = manual.length > 0 ? manual : auto;
      res.json({
        url,
        thumbnailUrl,
        durationSec: session.recording.durationSec,
        chapters,
        chaptersSource:
          manual.length > 0 ? 'manual' : auto.length > 0 ? 'auto' : 'none',
        summary: session.recording.summary,
        transcript: session.recording.transcript ?? [],
        expiresInSec: 60 * 30,
      });
    } catch (e) {
      next(e);
    }
  },
);
