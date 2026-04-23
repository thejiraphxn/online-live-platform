import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { requireAuth, requireCourseRole } from '../../middleware/auth.js';
import { pageSchema, toPaginated } from '../../lib/pagination.js';

export const sessionsRouter = Router({ mergeParams: true });

sessionsRouter.use(requireAuth);

const listSchema = pageSchema.extend({
  status: z
    .enum(['DRAFT', 'SCHEDULED', 'LIVE', 'ENDED'])
    .optional(),
});

sessionsRouter.get(
  '/',
  requireCourseRole('courseId', ['TEACHER', 'STUDENT'], { allowPublicRead: true }),
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
  requireCourseRole('courseId', ['TEACHER']),
  async (req, res, next) => {
    try {
      const body = createSchema.parse(req.body);
      const session = await prisma.courseSession.create({
        data: {
          courseId: req.params.courseId,
          title: body.title,
          description: body.description,
          scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : null,
          status: body.scheduledAt ? 'SCHEDULED' : 'DRAFT',
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
  requireCourseRole('courseId', ['TEACHER', 'STUDENT'], { allowPublicRead: true }),
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
  requireCourseRole('courseId', ['TEACHER']),
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
  requireCourseRole('courseId', ['TEACHER']),
  async (req, res, next) => {
    try {
      await prisma.courseSession.delete({ where: { id: req.params.sessionId } });
      res.status(204).end();
    } catch (e) {
      next(e);
    }
  },
);
