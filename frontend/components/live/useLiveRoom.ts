'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { connectSocket, type OLPSocket } from '@/lib/socket';
import { RTCMesh } from '@/lib/rtc';
import type { ChatAttachment, ChatMessage, Participant, Question } from '@/lib/live-types';

export type LiveRoomState = {
  connected: boolean;
  error: string | null;
  mySocketId: string | undefined;
  participants: Participant[];
  chat: ChatMessage[];
  questions: Question[];
  remoteStreams: Map<string, MediaStream>;
  handAcceptedBy: string | null; // when student hand is accepted, this is the teacher's socketId
};

export type LiveRoomActions = {
  sendChat: (text: string, attachment?: ChatAttachment | null) => void;
  askQuestion: (text: string) => void;
  answerQuestion: (questionId: string, answerText: string) => void;
  raiseHand: (raised: boolean) => void;
  acceptHand: (studentSocketId: string) => void;
  rejectHand: (studentSocketId: string) => void;
  publish: (stream: MediaStream | null) => void;
  leave: () => void;
};

/**
 * Connects to the live room for `sessionId` and manages chat, questions,
 * participant list, and WebRTC mesh peers. The caller is responsible for
 * providing a MediaStream via `publish()` when it wants to broadcast.
 */
export function useLiveRoom(sessionId: string, enabled = true): [LiveRoomState, LiveRoomActions] {
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mySocketId, setMySocketId] = useState<string | undefined>();
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [remoteStreams, setRemoteStreams] = useState<Map<string, MediaStream>>(new Map());
  const [handAcceptedBy, setHandAcceptedBy] = useState<string | null>(null);

  const socketRef = useRef<OLPSocket | null>(null);
  const meshRef = useRef<RTCMesh | null>(null);

  useEffect(() => {
    if (!enabled || !sessionId) return;
    let cancelled = false;

    (async () => {
      let s: OLPSocket;
      try {
        s = await connectSocket();
      } catch (e: any) {
        console.warn('[liveroom] socket connect failed:', e);
        setError(e?.message ?? 'socket unreachable');
        return;
      }
      if (cancelled) {
        s.disconnect();
        return;
      }
      socketRef.current = s;
      const mesh = new RTCMesh(
        s,
        () => s.id,
        {
          onRemoteStream: (id, stream) =>
            setRemoteStreams((m) => {
              const n = new Map(m);
              n.set(id, stream);
              return n;
            }),
          onPeerClosed: (id) =>
            setRemoteStreams((m) => {
              const n = new Map(m);
              n.delete(id);
              return n;
            }),
        },
      );
      meshRef.current = mesh;

      const joinRoom = () => {
        console.log('[live] connected, socket id:', s.id);
        setMySocketId(s.id);
        setConnected(true);
        s.emit('room:join', sessionId, (r) => {
          console.log('[live] room:join ack:', r);
          if (!r.ok) {
            setError(r.error);
            return;
          }
          setParticipants(r.participants);
          // Initiate WebRTC handshake with everyone already in the room
          for (const p of r.participants) if (p.socketId !== s.id) mesh.connectTo(p.socketId);
        });
      };
      // If the socket already connected before we attached the handler
      // (can happen on very fast links), fire the join flow immediately.
      if (s.connected) joinRoom();
      s.on('connect', joinRoom);
      s.on('connect_error', (e) => {
        console.warn('[live] connect_error:', e.message);
        setError(e.message);
      });
      s.on('disconnect', (reason) => {
        console.log('[live] disconnected:', reason);
        setConnected(false);
      });

      s.on('room:state', ({ participants }) => {
        console.log('[live] room:state:', participants.map((p) => `${p.role}/${p.name}`));
        setParticipants(participants);
        // Idempotent safety net: if room:joined was missed (slow network,
        // reconnect, etc.), make sure we have peer connections to everyone.
        for (const p of participants) {
          if (p.socketId !== s.id) mesh.connectTo(p.socketId);
        }
      });
      s.on('room:joined', (p) => {
        console.log('[live] room:joined:', p.role, p.name, p.socketId);
        setParticipants((xs) => [...xs.filter((x) => x.socketId !== p.socketId), p]);
        mesh.connectTo(p.socketId);
      });
      s.on('room:left', (p) => {
        setParticipants((xs) => xs.filter((x) => x.socketId !== p.socketId));
        mesh.closePeer(p.socketId);
      });
      s.on('room:updated', (p) => {
        setParticipants((xs) => xs.map((x) => (x.socketId === p.socketId ? p : x)));
      });

      s.on('chat:new', (msg) => setChat((xs) => [...xs, msg]));
      s.on('question:new', (q) => setQuestions((xs) => [...xs, q]));
      s.on('question:answered', (q) =>
        setQuestions((xs) => xs.map((x) => (x.id === q.id ? q : x))),
      );

      s.on('hand:accepted', ({ fromSocketId }) => setHandAcceptedBy(fromSocketId));
      s.on('hand:rejected', () => setHandAcceptedBy(null));
    })();

    return () => {
      cancelled = true;
      meshRef.current?.closeAll();
      if (socketRef.current) {
        socketRef.current.emit('room:leave', sessionId);
        socketRef.current.disconnect();
      }
      socketRef.current = null;
      meshRef.current = null;
    };
  }, [sessionId, enabled]);

  const actions: LiveRoomActions = {
    sendChat: useCallback(
      (text: string, attachment?: ChatAttachment | null) => {
        if (!text.trim() && !attachment) return;
        socketRef.current?.emit('chat:send', { sessionId, text, attachment });
      },
      [sessionId],
    ),
    askQuestion: useCallback(
      (text: string) => {
        if (!text.trim()) return;
        socketRef.current?.emit('question:ask', { sessionId, text });
      },
      [sessionId],
    ),
    answerQuestion: useCallback(
      (questionId: string, answerText: string) => {
        if (!answerText.trim()) return;
        socketRef.current?.emit('question:answer', { sessionId, questionId, answerText });
      },
      [sessionId],
    ),
    raiseHand: useCallback(
      (raised: boolean) =>
        socketRef.current?.emit('hand:raise', { sessionId, raised }),
      [sessionId],
    ),
    acceptHand: useCallback(
      (studentSocketId: string) =>
        socketRef.current?.emit('hand:accept', { sessionId, studentSocketId }),
      [sessionId],
    ),
    rejectHand: useCallback(
      (studentSocketId: string) =>
        socketRef.current?.emit('hand:reject', { sessionId, studentSocketId }),
      [sessionId],
    ),
    publish: useCallback((stream: MediaStream | null) => {
      // setLocalStream adds the tracks to every existing peer. addTrack
      // fires `negotiationneeded` on each RTCPeerConnection, which our
      // handler in rtc.ts uses to push a fresh offer. No manual
      // "connectTo for each participant" dance needed.
      meshRef.current?.setLocalStream(stream);
    }, []),
    leave: useCallback(() => {
      meshRef.current?.closeAll();
      socketRef.current?.emit('room:leave', sessionId);
    }, [sessionId]),
  };

  // Keep a ref of participants for publish() to reconnect everyone
  const participantsRef = useRef<Participant[]>([]);
  useEffect(() => {
    participantsRef.current = participants;
  }, [participants]);

  return [
    { connected, error, mySocketId, participants, chat, questions, remoteStreams, handAcceptedBy },
    actions,
  ];
}
