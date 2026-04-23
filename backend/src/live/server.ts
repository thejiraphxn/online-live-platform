import type { Server as HttpServer } from 'node:http';
import jwt from 'jsonwebtoken';
import { Server as IOServer } from 'socket.io';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import type {
  ClientToServerEvents,
  Participant,
  Question,
  ChatMessage,
  ServerToClientEvents,
} from './types.js';

type SocketData = {
  userId: string;
  name: string;
  joinedSessionId?: string;
  hasHandRaised: boolean;
  isPublishing: boolean;
};

function roomKey(sessionId: string) {
  return `session:${sessionId}`;
}

function isTeacher(role: string) {
  return role === 'TEACHER';
}

export function attachLiveServer(http: HttpServer) {
  // Match the HTTP CORS policy — support single / list / wildcard.
  const raw = config.corsOrigin.trim();
  const allowAll = raw === '*';
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const io = new IOServer<
    ClientToServerEvents,
    ServerToClientEvents,
    Record<string, never>,
    SocketData
  >(http, {
    cors: {
      origin: (origin, cb) => {
        if (!origin) return cb(null, true);
        if (allowAll) return cb(null, origin);
        if (list.includes(origin)) return cb(null, origin);
        return cb(new Error('cors'), false);
      },
      credentials: true,
    },
    pingInterval: 20_000,
    pingTimeout: 30_000,
  });

  // Auth: prefer handshake auth.token (set by browser from sessionStorage for
  // backward-compat); fall back to the `olp_token` httpOnly cookie sent with
  // the socket.io handshake — this is the norm for same-origin proxy setups.
  io.use(async (socket, next) => {
    try {
      const fromAuth = (socket.handshake.auth as any)?.token as string | undefined;
      const rawCookie = socket.handshake.headers.cookie ?? '';
      const fromCookie = rawCookie
        .split(';')
        .map((s) => s.trim())
        .find((s) => s.startsWith('olp_token='))
        ?.split('=')[1];
      const raw = fromAuth || fromCookie;
      if (!raw) return next(new Error('no-token'));
      const payload = jwt.verify(raw, config.jwtSecret) as { sub: string };
      const user = await prisma.user.findUnique({ where: { id: payload.sub } });
      if (!user) return next(new Error('invalid-user'));
      socket.data.userId = user.id;
      socket.data.name = user.name;
      socket.data.hasHandRaised = false;
      socket.data.isPublishing = false;
      next();
    } catch (e: any) {
      next(new Error(e?.message ?? 'auth-failed'));
    }
  });

  async function getMembership(userId: string, sessionId: string) {
    const session = await prisma.courseSession.findUnique({
      where: { id: sessionId },
      select: { courseId: true },
    });
    if (!session) return null;
    return prisma.courseMember.findUnique({
      where: { courseId_userId: { courseId: session.courseId, userId } },
    });
  }

  async function currentParticipants(sessionId: string): Promise<Participant[]> {
    const sockets = await io.in(roomKey(sessionId)).fetchSockets();
    const out: Participant[] = [];
    for (const s of sockets) {
      const member = await getMembership(s.data.userId, sessionId);
      if (!member) continue;
      out.push({
        socketId: s.id,
        userId: s.data.userId,
        name: s.data.name,
        role: member.role,
        hasHandRaised: s.data.hasHandRaised,
        isPublishing: s.data.isPublishing,
      });
    }
    return out;
  }

  io.on('connection', (socket) => {
    logger.info({ userId: socket.data.userId }, 'socket connected');

    socket.on('room:join', async (sessionId, ack) => {
      const member = await getMembership(socket.data.userId, sessionId);
      if (!member) {
        ack({ ok: false, error: 'not a member' });
        return;
      }
      if (socket.data.joinedSessionId && socket.data.joinedSessionId !== sessionId) {
        socket.leave(roomKey(socket.data.joinedSessionId));
      }
      socket.data.joinedSessionId = sessionId;
      socket.data.hasHandRaised = false;
      socket.data.isPublishing = isTeacher(member.role);
      socket.join(roomKey(sessionId));

      const me: Participant = {
        socketId: socket.id,
        userId: socket.data.userId,
        name: socket.data.name,
        role: member.role,
        hasHandRaised: false,
        isPublishing: socket.data.isPublishing,
      };
      socket.to(roomKey(sessionId)).emit('room:joined', me);
      const participants = await currentParticipants(sessionId);
      ack({ ok: true, participants });
      io.to(roomKey(sessionId)).emit('room:state', { participants });
    });

    socket.on('room:leave', (sessionId) => {
      socket.leave(roomKey(sessionId));
      socket.to(roomKey(sessionId)).emit('room:left', {
        socketId: socket.id,
        userId: socket.data.userId,
        name: socket.data.name,
      });
    });

    socket.on('chat:send', async ({ sessionId, text, attachment }) => {
      if (socket.data.joinedSessionId !== sessionId) return;
      const trimmed = (text ?? '').trim();
      if (!trimmed && !attachment) return;
      if (trimmed.length > 1000) return;
      const member = await getMembership(socket.data.userId, sessionId);
      if (!member) return;
      const row = await prisma.sessionChatMessage.create({
        data: {
          sessionId,
          userId: socket.data.userId,
          text: trimmed,
          attachmentKey: attachment?.key,
          attachmentName: attachment?.name,
          attachmentMimeType: attachment?.mimeType,
          attachmentSize: attachment?.size,
        },
      });
      const msg: ChatMessage = {
        id: row.id,
        sessionId,
        userId: socket.data.userId,
        userName: socket.data.name,
        userRole: member.role,
        text: row.text,
        attachment: row.attachmentKey
          ? {
              key: row.attachmentKey,
              name: row.attachmentName ?? 'attachment',
              mimeType: row.attachmentMimeType ?? 'application/octet-stream',
              size: row.attachmentSize ?? 0,
            }
          : null,
        createdAt: row.createdAt.toISOString(),
      };
      io.to(roomKey(sessionId)).emit('chat:new', msg);
    });

    socket.on('question:ask', async ({ sessionId, text }) => {
      if (!text?.trim() || text.length > 500) return;
      const member = await getMembership(socket.data.userId, sessionId);
      if (!member) return;
      const row = await prisma.sessionQuestion.create({
        data: { sessionId, askedByUserId: socket.data.userId, text: text.trim() },
      });
      const q: Question = {
        id: row.id,
        sessionId,
        askedByUserId: socket.data.userId,
        askedByName: socket.data.name,
        text: row.text,
        answeredAt: null,
        answeredByUserId: null,
        answeredByName: null,
        answerText: null,
        createdAt: row.createdAt.toISOString(),
      };
      io.to(roomKey(sessionId)).emit('question:new', q);
    });

    socket.on('question:answer', async ({ sessionId, questionId, answerText }) => {
      if (!answerText?.trim() || answerText.length > 2000) return;
      const member = await getMembership(socket.data.userId, sessionId);
      if (!member || !isTeacher(member.role)) return;
      const row = await prisma.sessionQuestion.update({
        where: { id: questionId },
        data: {
          answerText: answerText.trim(),
          answeredAt: new Date(),
          answeredByUserId: socket.data.userId,
        },
        include: { askedBy: true, answeredBy: true },
      });
      const q: Question = {
        id: row.id,
        sessionId: row.sessionId,
        askedByUserId: row.askedByUserId,
        askedByName: row.askedBy.name,
        text: row.text,
        answeredAt: row.answeredAt!.toISOString(),
        answeredByUserId: row.answeredByUserId,
        answeredByName: row.answeredBy?.name ?? null,
        answerText: row.answerText,
        createdAt: row.createdAt.toISOString(),
      };
      io.to(roomKey(sessionId)).emit('question:answered', q);
    });

    socket.on('hand:raise', async ({ sessionId, raised }) => {
      if (socket.data.joinedSessionId !== sessionId) return;
      socket.data.hasHandRaised = raised;
      const member = await getMembership(socket.data.userId, sessionId);
      if (!member) return;
      const p: Participant = {
        socketId: socket.id,
        userId: socket.data.userId,
        name: socket.data.name,
        role: member.role,
        hasHandRaised: raised,
        isPublishing: socket.data.isPublishing,
      };
      io.to(roomKey(sessionId)).emit('room:updated', p);
    });

    socket.on('hand:accept', async ({ sessionId, studentSocketId }) => {
      const member = await getMembership(socket.data.userId, sessionId);
      if (!member || !isTeacher(member.role)) return;
      io.to(studentSocketId).emit('hand:accepted', { fromSocketId: socket.id });
      const target = io.sockets.sockets.get(studentSocketId);
      if (target) target.data.isPublishing = true;
      io.to(roomKey(sessionId)).emit('room:state', {
        participants: await currentParticipants(sessionId),
      });
    });

    socket.on('hand:reject', async ({ sessionId, studentSocketId }) => {
      const member = await getMembership(socket.data.userId, sessionId);
      if (!member || !isTeacher(member.role)) return;
      io.to(studentSocketId).emit('hand:rejected');
    });

    // WebRTC signaling relay
    socket.on('rtc:offer', ({ to, sdp }) => {
      io.to(to).emit('rtc:offer', { from: socket.id, sdp });
    });
    socket.on('rtc:answer', ({ to, sdp }) => {
      io.to(to).emit('rtc:answer', { from: socket.id, sdp });
    });
    socket.on('rtc:ice', ({ to, candidate }) => {
      io.to(to).emit('rtc:ice', { from: socket.id, candidate });
    });

    socket.on('disconnect', () => {
      const sessionId = socket.data.joinedSessionId;
      if (sessionId) {
        socket.to(roomKey(sessionId)).emit('room:left', {
          socketId: socket.id,
          userId: socket.data.userId,
          name: socket.data.name,
        });
        // re-broadcast state to survivors
        currentParticipants(sessionId)
          .then((participants) =>
            io.to(roomKey(sessionId)).emit('room:state', { participants }),
          )
          .catch(() => {});
      }
      logger.info({ userId: socket.data.userId }, 'socket disconnected');
    });
  });

  return io;
}
