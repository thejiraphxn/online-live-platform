import { Router } from 'express';
import { z } from 'zod';
import { CourseRole, SessionStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { requireAuth, requireCourseRole } from '../../middleware/auth.js';
import { pageSchema, toPaginated } from '../../lib/pagination.js';

export const sessionsRouter = Router({ mergeParams: true });

sessionsRouter.use(requireAuth);

const listSchema = pageSchema.extend({
  status: z.nativeEnum(SessionStatus).optional(),
});

sessionsRouter.get(
  '/',
  requireCourseRole('courseId', [CourseRole.TEACHER, CourseRole.STUDENT], { allowPublicRead: true }),
  async (req, res, next) => {
    try {
      const { page, limit, q, status } = listSchema.parse(req.query);
      const where: any = { courseId: req.params.courseId };
      if (status) where.status = status;
      if (q)
        where.OR = [
          { title: { contains: q, mode: 'insensitive' } },
          { description: { contains: q, mode: 'insensitive' } },
        ];

      const [total, sessions] = await Promise.all([
        prisma.courseSession.count({ where }),
        prisma.courseSession.findMany({
          where,
          include: { recording: true },
          orderBy: { scheduledAt: 'asc' },
          skip: (page - 1) * limit,
          take: limit,
        }),
      ]);
      res.json(toPaginated(sessions, total, { page, limit, q }));
    } catch (e) {
      next(e);
    }
  },
);

const createSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  scheduledAt: z.string().datetime().optional(),
});

sessionsRouter.post(
  '/',
  requireCourseRole('courseId', [CourseRole.TEACHER]),
  async (req, res, next) => {
    try {
      const body = createSchema.parse(req.body);
      const session = await prisma.courseSession.create({
        data: {
          courseId: req.params.courseId,
          title: body.title,
          description: body.description,
          scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : null,
          status: body.scheduledAt ? SessionStatus.SCHEDULED : SessionStatus.DRAFT,
        },
      });
      res.status(201).json(session);
    } catch (e) {
      next(e);
    }
  },
);

sessionsRouter.get(
  '/:sessionId',
  requireCourseRole('courseId', [CourseRole.TEACHER, CourseRole.STUDENT], { allowPublicRead: true }),
  async (req, res, next) => {
    try {
      const session = await prisma.courseSession.findUnique({
        where: { id: req.params.sessionId },
        include: { recording: true },
      });
      if (!session || session.courseId !== req.params.courseId)
        return res.status(404).json({ error: 'not found' });
      res.json(session);
    } catch (e) {
      next(e);
    }
  },
);

sessionsRouter.patch(
  '/:sessionId',
  requireCourseRole('courseId', [CourseRole.TEACHER]),
  async (req, res, next) => {
    try {
      const body = createSchema.partial().parse(req.body);
      const session = await prisma.courseSession.update({
        where: { id: req.params.sessionId },
        data: {
          ...body,
          scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : undefined,
        },
      });
      res.json(session);
    } catch (e) {
      next(e);
    }
  },
);

sessionsRouter.delete(
  '/:sessionId',
  requireCourseRole('courseId', [CourseRole.TEACHER]),
  async (req, res, next) => {
    try {
      await prisma.courseSession.delete({ where: { id: req.params.sessionId } });
      res.status(204).end();
    } catch (e) {
      next(e);
    }
  },
);

// Attendance report — teacher-only. Aggregates every stint a user spent in
// the live room, sums to totalSeconds, and includes raw stints for detail.
sessionsRouter.get(
  '/:sessionId/attendance',
  requireCourseRole('courseId', [CourseRole.TEACHER]),
  async (req, res, next) => {
    try {
      const stints = await prisma.sessionAttendance.findMany({
        where: { sessionId: req.params.sessionId },
        orderBy: { joinedAt: 'asc' },
        include: {
          user: { select: { id: true, name: true, email: true } },
        },
      });

      // Also surface enrolled students who never showed up, so the teacher
      // sees a full roster not just "who connected".
      const members = await prisma.courseMember.findMany({
        where: { courseId: req.params.courseId },
        include: { user: { select: { id: true, name: true, email: true } } },
      });

      const now = Date.now();
      type Row = {
        userId: string;
        userName: string;
        email: string;
        role: CourseRole;
        totalSeconds: number;
        stintCount: number;
        firstSeenAt: string | null;
        lastSeenAt: string | null;
        stints: { joinedAt: string; leftAt: string | null; seconds: number }[];
      };
      const byUser = new Map<string, Row>();
      for (const m of members) {
        byUser.set(m.userId, {
          userId: m.userId,
          userName: m.user.name,
          email: m.user.email,
          role: m.role,
          totalSeconds: 0,
          stintCount: 0,
          firstSeenAt: null,
          lastSeenAt: null,
          stints: [],
        });
      }
      for (const s of stints) {
        // Defensive — if someone attended without a CourseMember row (e.g.
        // removed from course afterwards) synthesize a row for them.
        let row = byUser.get(s.userId);
        if (!row) {
          row = {
            userId: s.userId,
            userName: s.user.name,
            email: s.user.email,
            role: CourseRole.STUDENT,
            totalSeconds: 0,
            stintCount: 0,
            firstSeenAt: null,
            lastSeenAt: null,
            stints: [],
          };
          byUser.set(s.userId, row);
        }
        const endMs = s.leftAt ? s.leftAt.getTime() : now; // open stint → live now
        const startMs = s.joinedAt.getTime();
        const seconds = Math.max(0, Math.round((endMs - startMs) / 1000));
        row.stints.push({
          joinedAt: s.joinedAt.toISOString(),
          leftAt: s.leftAt ? s.leftAt.toISOString() : null,
          seconds,
        });
        row.totalSeconds += seconds;
        row.stintCount += 1;
        if (!row.firstSeenAt || startMs < new Date(row.firstSeenAt).getTime()) {
          row.firstSeenAt = s.joinedAt.toISOString();
        }
        const endIso = s.leftAt ? s.leftAt.toISOString() : new Date(endMs).toISOString();
        if (!row.lastSeenAt || endMs > new Date(row.lastSeenAt).getTime()) {
          row.lastSeenAt = endIso;
        }
      }
      // Sort: attended first (descending by time), no-shows last by name.
      const rows = Array.from(byUser.values()).sort((a, b) => {
        if (a.totalSeconds !== b.totalSeconds) return b.totalSeconds - a.totalSeconds;
        return a.userName.localeCompare(b.userName);
      });
      res.json({ attendance: rows });
    } catch (e) {
      next(e);
    }
  },
);
