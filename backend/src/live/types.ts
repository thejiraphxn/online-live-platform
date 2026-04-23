/**
 * Shared socket event types. Imported on both server and (copied to) client.
 *
 * Room key = `session:<sessionId>`. One room per session.
 */

export type Role = 'TEACHER' | 'STUDENT';

export type Participant = {
  socketId: string;
  userId: string;
  name: string;
  role: Role;
  hasHandRaised: boolean;
  isPublishing: boolean; // currently streaming cam/mic
};

// Client → Server
export interface ClientToServerEvents {
  'room:join': (sessionId: string, ack: (r: RoomJoinResult) => void) => void;
  'room:leave': (sessionId: string) => void;

  'chat:send': (payload: {
    sessionId: string;
    text: string;
    attachment?: ChatAttachment | null;
  }) => void;
  'question:ask': (payload: { sessionId: string; text: string }) => void;
  'question:answer': (payload: {
    sessionId: string;
    questionId: string;
    answerText: string;
  }) => void;

  'hand:raise': (payload: { sessionId: string; raised: boolean }) => void;
  'hand:accept': (payload: { sessionId: string; studentSocketId: string }) => void;
  'hand:reject': (payload: { sessionId: string; studentSocketId: string }) => void;

  // WebRTC signaling — relayed verbatim to the `to` socket
  'rtc:offer': (payload: { to: string; sdp: RTCSessionDescriptionInit }) => void;
  'rtc:answer': (payload: { to: string; sdp: RTCSessionDescriptionInit }) => void;
  'rtc:ice': (payload: { to: string; candidate: RTCIceCandidateInit }) => void;
}

// Server → Client
export interface ServerToClientEvents {
  'room:state': (state: { participants: Participant[] }) => void;
  'room:joined': (p: Participant) => void;
  'room:left': (p: Pick<Participant, 'socketId' | 'userId' | 'name'>) => void;
  'room:updated': (p: Participant) => void;

  'chat:new': (msg: ChatMessage) => void;
  'question:new': (q: Question) => void;
  'question:answered': (q: Question) => void;

  'hand:accepted': (payload: { fromSocketId: string }) => void;
  'hand:rejected': () => void;

  'rtc:offer': (payload: { from: string; sdp: RTCSessionDescriptionInit }) => void;
  'rtc:answer': (payload: { from: string; sdp: RTCSessionDescriptionInit }) => void;
  'rtc:ice': (payload: { from: string; candidate: RTCIceCandidateInit }) => void;
}

export type RoomJoinResult =
  | { ok: true; participants: Participant[] }
  | { ok: false; error: string };

export type ChatAttachment = {
  key: string;
  name: string;
  mimeType: string;
  size: number;
};

export type ChatMessage = {
  id: string;
  sessionId: string;
  userId: string;
  userName: string;
  userRole: Role;
  text: string;
  attachment: ChatAttachment | null;
  createdAt: string;
};

export type Question = {
  id: string;
  sessionId: string;
  askedByUserId: string;
  askedByName: string;
  text: string;
  answeredAt: string | null;
  answeredByUserId: string | null;
  answeredByName: string | null;
  answerText: string | null;
  createdAt: string;
};
