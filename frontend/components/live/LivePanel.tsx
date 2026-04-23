'use client';
import { useEffect, useRef, useState } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import type { LiveRoomActions, LiveRoomState } from './useLiveRoom';
import type { ChatAttachment, ChatMessage, Participant } from '@/lib/live-types';
import { api } from '@/lib/api';
import { CourseRole } from '@/lib/enums';
import { playChime, ensureNotificationPermission, showDesktopNotification } from '@/lib/notify';
import { useToast } from '@/components/ui/Toast';

type Props = {
  state: LiveRoomState;
  actions: LiveRoomActions;
  myRole: CourseRole;
  courseId: string;
  sessionId: string;
};

export function LivePanel({ state, actions, myRole, courseId, sessionId }: Props) {
  const [tab, setTab] = useState<'chat' | 'questions' | 'people'>('chat');
  const unansweredCount = state.questions.filter((q) => !q.answeredAt).length;
  const handsRaised = state.participants.filter(
    (p) => p.role === CourseRole.STUDENT && p.hasHandRaised,
  ).length;
  const toast = useToast();

  // Ask for desktop notification permission once the teacher opens the room.
  useEffect(() => {
    if (myRole === CourseRole.TEACHER) void ensureNotificationPermission();
  }, [myRole]);

  // Detect new hand raises and notify the teacher (sound + toast + desktop).
  const prevHandsRef = useRef<Map<string, boolean>>(new Map());
  useEffect(() => {
    if (myRole !== CourseRole.TEACHER) return;
    const next = new Map<string, boolean>();
    const newly: Participant[] = [];
    for (const p of state.participants) {
      next.set(p.socketId, p.hasHandRaised);
      if (
        p.role === CourseRole.STUDENT &&
        p.hasHandRaised &&
        !prevHandsRef.current.get(p.socketId)
      ) {
        newly.push(p);
      }
    }
    prevHandsRef.current = next;
    for (const p of newly) {
      playChime();
      toast.info(`✋ ${p.name} raised their hand`);
      void showDesktopNotification(
        `${p.name} raised their hand`,
        'Click to open the classroom',
        { tag: `hand:${p.socketId}` },
      );
    }
  }, [state.participants, myRole, toast]);

  // Notify on new unanswered questions too (teacher only).
  const prevQCountRef = useRef(0);
  useEffect(() => {
    if (myRole !== CourseRole.TEACHER) return;
    if (unansweredCount > prevQCountRef.current) {
      const newest = state.questions[state.questions.length - 1];
      if (newest && !newest.answeredAt) {
        playChime();
        toast.info(`❓ ${newest.askedByName} asked a question`);
        void showDesktopNotification(
          `New question from ${newest.askedByName}`,
          newest.text.slice(0, 100),
          { tag: `q:${newest.id}` },
        );
      }
    }
    prevQCountRef.current = unansweredCount;
  }, [unansweredCount, state.questions, myRole, toast]);

  return (
    <div className="border border-ink rounded flex flex-col bg-paper overflow-hidden h-[640px]">
      <div className="flex border-b border-ink bg-paper-alt">
        <TabBtn active={tab === 'chat'} onClick={() => setTab('chat')}>
          Chat <span className="text-[10px] font-mono text-ink-mute ml-1">{state.chat.length}</span>
        </TabBtn>
        <TabBtn active={tab === 'questions'} onClick={() => setTab('questions')}>
          Questions{' '}
          {unansweredCount > 0 && (
            <span className="ml-1 px-1.5 rounded-full bg-warn text-white text-[10px] font-bold">
              {unansweredCount}
            </span>
          )}
        </TabBtn>
        <TabBtn active={tab === 'people'} onClick={() => setTab('people')}>
          People{' '}
          {handsRaised > 0 && (
            <span className="ml-1 px-1.5 rounded-full bg-warn text-white text-[10px] font-bold animate-pulse">
              ✋ {handsRaised}
            </span>
          )}
          <span className="text-[10px] font-mono text-ink-mute ml-1">
            {state.participants.length}
          </span>
        </TabBtn>
      </div>

      {tab === 'chat' && (
        <ChatTab
          state={state}
          actions={actions}
          courseId={courseId}
          sessionId={sessionId}
        />
      )}
      {tab === 'questions' && <QuestionsTab state={state} actions={actions} myRole={myRole} />}
      {tab === 'people' && <PeopleTab state={state} actions={actions} myRole={myRole} />}
    </div>
  );
}

function AttachmentView({
  attachment,
  courseId,
  sessionId,
}: {
  attachment: ChatAttachment;
  courseId: string;
  sessionId: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    api<{ url: string }>(
      `/courses/${courseId}/sessions/${sessionId}/uploads/sign?key=${encodeURIComponent(
        attachment.key,
      )}`,
    )
      .then((r) => setUrl(r.url))
      .catch(() => {});
  }, [attachment.key, courseId, sessionId]);
  const isImage = attachment.mimeType.startsWith('image/');
  if (isImage && url) {
    return (
      <a href={url} target="_blank" rel="noreferrer" className="block mt-1 max-w-[240px]">
        <img
          src={url}
          alt={attachment.name}
          className="rounded border border-ink/30 max-h-40 object-contain"
        />
      </a>
    );
  }
  return (
    <a
      href={url ?? '#'}
      target="_blank"
      rel="noreferrer"
      className="mt-1 inline-flex items-center gap-2 border border-ink/30 rounded px-2 py-1 bg-paper-alt text-xs max-w-full hover:bg-accent-soft"
    >
      <span>📎</span>
      <span className="truncate flex-1">{attachment.name}</span>
      <span className="text-ink-mute font-mono">
        {Math.round(attachment.size / 1024)}&nbsp;KB
      </span>
    </a>
  );
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={[
        'flex-1 py-2.5 text-sm font-semibold border-r last:border-r-0 border-ink/20',
        active ? 'bg-paper text-accent border-b-2 border-b-accent -mb-px' : 'text-ink-soft hover:text-ink',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

function ChatTab({
  state,
  actions,
  courseId,
  sessionId,
}: {
  state: LiveRoomState;
  actions: LiveRoomActions;
  courseId: string;
  sessionId: string;
}) {
  const [text, setText] = useState('');
  const [uploading, setUploading] = useState(false);
  const [pendingAttachment, setPendingAttachment] = useState<ChatAttachment | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 9999999, behavior: 'smooth' });
  }, [state.chat.length]);

  async function pickAndUpload(file: File) {
    setUploading(true);
    try {
      const init = await api<{ url: string; key: string }>(
        `/courses/${courseId}/sessions/${sessionId}/uploads/init`,
        {
          method: 'POST',
          body: {
            filename: file.name,
            mimeType: file.type || 'application/octet-stream',
            size: file.size,
          },
        },
      );
      const res = await fetch(init.url, {
        method: 'PUT',
        body: file,
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
      });
      if (!res.ok) throw new Error(`upload failed (${res.status})`);
      setPendingAttachment({
        key: init.key,
        name: file.name,
        mimeType: file.type || 'application/octet-stream',
        size: file.size,
      });
    } catch (e: any) {
      alert(e?.message ?? 'upload failed');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim() && !pendingAttachment) return;
    actions.sendChat(text, pendingAttachment);
    setText('');
    setPendingAttachment(null);
  }

  return (
    <>
      <div ref={scrollRef} className="flex-1 overflow-auto p-3 flex flex-col gap-2 text-sm">
        {state.chat.length === 0 && (
          <div className="text-xs text-ink-mute text-center my-6">
            No messages yet. Say hi 👋
          </div>
        )}
        {state.chat.map((m) => (
          <div key={m.id} className="flex gap-2 items-start">
            <Avatar name={m.userName} size={24} />
            <div className="min-w-0 flex-1">
              <div className="flex gap-1.5 items-baseline">
                <span className="font-bold text-xs">{m.userName}</span>
                {m.userRole === CourseRole.TEACHER && (
                  <span className="text-[9px] text-accent font-bold">TEACHER</span>
                )}
                <span className="font-mono text-[10px] text-ink-mute">
                  {new Date(m.createdAt).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </div>
              {m.text && <div className="text-sm break-words">{m.text}</div>}
              {m.attachment && (
                <AttachmentView
                  attachment={m.attachment}
                  courseId={courseId}
                  sessionId={sessionId}
                />
              )}
            </div>
          </div>
        ))}
      </div>
      {pendingAttachment && (
        <div className="px-2 pt-2 flex items-center gap-2 text-xs bg-accent-soft/60 border-t border-ink">
          <span>📎</span>
          <span className="truncate flex-1">{pendingAttachment.name}</span>
          <span className="text-ink-mute font-mono">
            {Math.round(pendingAttachment.size / 1024)} KB
          </span>
          <button
            type="button"
            onClick={() => setPendingAttachment(null)}
            className="text-ink-mute hover:text-live"
          >
            ×
          </button>
        </div>
      )}
      <form className="border-t border-ink p-2 flex gap-2" onSubmit={submit}>
        <input
          ref={fileRef}
          type="file"
          hidden
          onChange={(e) => {
            const f = e.currentTarget.files?.[0];
            if (f) pickAndUpload(f);
          }}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={!state.connected || uploading}
          title="Attach file"
          className="h-9 w-9 border border-ink rounded flex items-center justify-center hover:bg-paper-alt disabled:opacity-50"
        >
          {uploading ? '…' : '📎'}
        </button>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={state.connected ? 'Message…' : 'Connecting…'}
          disabled={!state.connected}
          className="flex-1 h-9 px-2 border border-ink rounded text-sm"
        />
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabled={!state.connected || (!text.trim() && !pendingAttachment)}
        >
          Send
        </Button>
      </form>
    </>
  );
}

function QuestionsTab({
  state,
  actions,
  myRole,
}: {
  state: LiveRoomState;
  actions: LiveRoomActions;
  myRole: CourseRole;
}) {
  const [draft, setDraft] = useState('');
  return (
    <>
      <div className="flex-1 overflow-auto p-3 flex flex-col gap-3 text-sm">
        {state.questions.length === 0 && (
          <div className="text-xs text-ink-mute text-center my-6">
            {myRole === CourseRole.STUDENT
              ? 'No questions yet. Ask below — the teacher will see it live or answer later.'
              : 'Questions from students will appear here in real time.'}
          </div>
        )}
        {state.questions.map((q) => (
          <QuestionItem key={q.id} q={q} myRole={myRole} answer={actions.answerQuestion} />
        ))}
      </div>
      {myRole === CourseRole.STUDENT && (
        <form
          className="border-t border-ink p-2 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            actions.askQuestion(draft);
            setDraft('');
          }}
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={state.connected ? 'Ask the teacher…' : 'Connecting…'}
            disabled={!state.connected}
            className="flex-1 h-9 px-2 border border-ink rounded text-sm"
          />
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={!state.connected || !draft.trim()}
          >
            Ask
          </Button>
        </form>
      )}
    </>
  );
}

function QuestionItem({
  q,
  myRole,
  answer,
}: {
  q: import('@/lib/live-types').Question;
  myRole: CourseRole;
  answer: (id: string, text: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const [answering, setAnswering] = useState(false);
  return (
    <div className="border border-ink rounded p-2.5 flex flex-col gap-2 bg-paper">
      <div className="flex items-start gap-2">
        <Avatar name={q.askedByName} size={22} />
        <div className="flex-1 min-w-0">
          <div className="flex gap-1.5 items-baseline">
            <span className="font-bold text-xs">{q.askedByName}</span>
            <span className="font-mono text-[10px] text-ink-mute">
              {new Date(q.createdAt).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
          </div>
          <div className="text-sm mt-0.5">{q.text}</div>
        </div>
        {!q.answeredAt && (
          <span className="text-[9px] font-bold px-1.5 py-0.5 bg-warn-soft text-warn border border-warn rounded">
            unanswered
          </span>
        )}
      </div>
      {q.answeredAt && q.answerText && (
        <div className="ml-8 border-l-2 border-accent pl-2 text-sm bg-accent-soft/30 rounded py-1">
          <div className="text-[10px] text-accent font-bold">
            ANSWERED by {q.answeredByName}
          </div>
          {q.answerText}
        </div>
      )}
      {myRole === CourseRole.TEACHER && !q.answeredAt && (
        <>
          {!answering ? (
            <button
              onClick={() => setAnswering(true)}
              className="text-xs text-accent hover:underline text-left ml-8"
            >
              ↩ Answer
            </button>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                answer(q.id, draft);
                setDraft('');
                setAnswering(false);
              }}
              className="ml-8 flex gap-2"
            >
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Your answer…"
                className="flex-1 h-8 px-2 border border-ink rounded text-sm"
              />
              <Button type="submit" variant="primary" size="sm" disabled={!draft.trim()}>
                Send
              </Button>
            </form>
          )}
        </>
      )}
    </div>
  );
}

function PeopleTab({
  state,
  actions,
  myRole,
}: {
  state: LiveRoomState;
  actions: LiveRoomActions;
  myRole: CourseRole;
}) {
  return (
    <div className="flex-1 overflow-auto p-3 flex flex-col gap-1.5 text-sm">
      {state.participants.map((p) => (
        <div
          key={p.socketId}
          className="flex items-center gap-2 p-1.5 rounded hover:bg-paper-alt"
        >
          <Avatar name={p.name} size={24} />
          <div className="flex-1 min-w-0">
            <div className="font-semibold text-sm truncate">{p.name}</div>
            <div className="flex gap-1.5 items-center">
              <span
                className={
                  p.role === CourseRole.TEACHER
                    ? 'text-[10px] font-bold text-accent'
                    : 'text-[10px] text-ink-mute'
                }
              >
                {p.role}
              </span>
              {p.isPublishing && (
                <span className="text-[10px] text-live font-bold">● live</span>
              )}
              {p.hasHandRaised && (
                <span className="text-[10px] text-warn font-bold">✋ hand up</span>
              )}
            </div>
          </div>
          {myRole === CourseRole.TEACHER && p.hasHandRaised && p.role === CourseRole.STUDENT && (
            <div className="flex gap-1">
              <Button
                variant="primary"
                size="sm"
                onClick={() => actions.acceptHand(p.socketId)}
              >
                Accept
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => actions.rejectHand(p.socketId)}
              >
                Reject
              </Button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
