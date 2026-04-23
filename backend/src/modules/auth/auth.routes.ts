import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { CourseRole } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { config } from '../../config.js';
import { requireAuth } from '../../middleware/auth.js';
import { authLimiter, demoLimiter } from '../../middleware/rateLimit.js';

export const authRouter = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

function issueToken(userId: string) {
  return jwt.sign({ sub: userId }, config.jwtSecret, { expiresIn: config.jwtExpiresIn } as any);
}

function setCookie(res: any, token: string) {
  res.cookie('olp_token', token, {
    httpOnly: true,
    sameSite: config.cookie.sameSite,
    secure: config.cookie.secure,
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

const registerSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(80),
  password: z.string().min(8).max(128),
});

authRouter.post('/register', authLimiter, async (req, res, next) => {
  try {
    const { email, name, password } = registerSchema.parse(req.body);
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return res.status(409).json({ error: 'email already in use' });
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({ data: { email, name, passwordHash } });
    const token = issueToken(user.id);
    setCookie(res, token);
    res.status(201).json({ token, user: { id: user.id, email: user.email, name: user.name } });
  } catch (e) {
    next(e);
  }
});

authRouter.post('/login', authLimiter, async (req, res, next) => {
  try {
    const { email, password } = loginSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ error: 'invalid credentials' });
    }
    const token = issueToken(user.id);
    setCookie(res, token);
    res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
  } catch (e) {
    next(e);
  }
});

authRouter.get('/demo/list', demoLimiter, async (_req, res, next) => {
  try {
    const users = await prisma.user.findMany({
      where: { isDemo: true },
      select: {
        id: true,
        name: true,
        email: true,
        demoBlurb: true,
        memberships: { select: { role: true }, take: 1, orderBy: { joinedAt: 'asc' } },
      },
      orderBy: { createdAt: 'asc' },
      take: 10,
    });
    res.json(
      users.map((u) => ({
        name: u.name,
        email: u.email,
        blurb: u.demoBlurb,
        // "primary role" = the first course role they have, falling back to STUDENT.
        role: u.memberships[0]?.role ?? CourseRole.STUDENT,
      })),
    );
  } catch (e) {
    next(e);
  }
});

authRouter.post('/demo/switch', demoLimiter, async (req, res, next) => {
  try {
    const { email } = z.object({ email: z.string().email() }).parse(req.body);
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.isDemo)
      return res.status(404).json({ error: 'persona not found' });
    const token = issueToken(user.id);
    setCookie(res, token);
    res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
  } catch (e) {
    next(e);
  }
});

authRouter.post('/logout', (_req, res) => {
  res.clearCookie('olp_token');
  res.json({ ok: true });
});

authRouter.get('/me', requireAuth, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId! },
      include: {
        memberships: {
          include: { course: { select: { id: true, code: true, title: true } } },
        },
      },
    });
    if (!user) return res.status(404).json({ error: 'not found' });
    res.json({
      id: user.id,
      email: user.email,
      name: user.name,
      memberships: user.memberships.map((m) => ({
        courseId: m.courseId,
        role: m.role,
        course: m.course,
      })),
    });
  } catch (e) {
    next(e);
  }
});
