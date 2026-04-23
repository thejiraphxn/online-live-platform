'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { StatusPill, sessionStatusPillKind } from '@/components/ui/StatusPill';
import { fmtDuration } from '@/lib/format';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { StudentLive } from '@/components/live/StudentLive';
import { CourseRole, RecordingStatus, SessionStatus } from '@/lib/enums';

type Chapter = { timeSec: number; label: string };
type TranscriptSegment = { startSec: number; endSec: number; text: string };

type ArchivedQuestion = {
  id: string;
  askedByName: string;
  text: string;
  answeredAt: string | null;
  answeredByName: string | null;
  answerText: string | null;
  createdAt: string;
};

type Session = {
  id: string;
  courseId: string;
  title: string;
  description: string | null;
  status: string;
  scheduledAt: string | null;
  recording: null | {
    id: string;
    status: string;
    durationSec: number | null;
    errorMessage?: string | null;
    updatedAt?: string;
  };
};

type Playback = {
  url: string;
  thumbnailUrl: string | null;
  durationSec: number | null;
  chapters: Chapter[];
  chaptersSource: 'manual' | 'auto' | 'none';
  summary: string | null;
  transcript: TranscriptSegment[];
  expiresInSec: number;
};


export default function SessionPage({ params }: { params: { courseId: string; sessionId: string } }) {
  const [session, setSession] = useState<Session | null>(null);
  const [playback, setPlayback] = useState<Playback | null>(null);
  const [myRole, setMyRole] = useState<CourseRole | null>(null);
  const [archivedQs, setArchivedQs] = useState<ArchivedQuestion[]>([]);
  const [newQ, setNewQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [activeChapter, setActiveChapter] = useState(0);
  const [focusMode, setFocusMode] = useState(false);
  const [tab, setTab] = useState<'transcript' | 'notes'>('transcript');
  const [activeTranscript, setActiveTranscript] = useState(0);
  const [transcriptSearch, setTranscriptSearch] = useState('');
  const [startedAtPos, setStartedAtPos] = useState<number | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const lastSavedRef = useRef(0);
  const toast = useToast();

  // Mount: fetch everything once. Once playback is set we never refetch it —
  // the presigned URL is valid for 30 minutes, and refetching regenerates a
  // new signed URL which forces the <video> element to reload mid-playback.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [s, course] = await Promise.all([
          api<Session>(`/courses/${params.courseId}/sessions/${params.sessionId}`),
          api<any>(`/courses/${params.courseId}`),
        ]);
        if (cancelled) return;
        setSession(s);
        setMyRole(course.myRole);

        try {
          const p = await api<Playback>(
            `/courses/${params.courseId}/sessions/${params.sessionId}/playback`,
          );
          if (!cancelled) setPlayback(p);
        } catch {
          // not ready yet — poller below will pick it up
        }

        try {
          const cont = await api<any[]>('/progress/continue');
          const row = cont.find((x) => x.sessionId === params.sessionId);
          if (!cancelled) setStartedAtPos(row ? row.positionSec : 0);
        } catch {
          if (!cancelled) setStartedAtPos(0);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [params.courseId, params.sessionId]);

  // Poll the session until the recording is READY (video playable).
  // We deliberately do NOT include `playback` in the stop condition here —
  // once we have a playback URL it's stable.
  useEffect(() => {
    if (playback) return;
    if (session?.recording?.status === RecordingStatus.READY) return;
    const t = setInterval(async () => {
      try {
        const s = await api<Session>(
          `/courses/${params.courseId}/sessions/${params.sessionId}`,
        );
        setSession(s);
        if (s.recording?.status === RecordingStatus.READY) {
          const p = await api<Playback>(
            `/courses/${params.courseId}/sessions/${params.sessionId}/playback`,
          );
          setPlayback(p);
        }
      } catch {}
    }, 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playback, session?.recording?.status, params.courseId, params.sessionId]);

  // Separate poller: once video is READY but transcript/summary haven't been
  // filled in yet by the worker's stage-2 post-processing, re-fetch /playback
  // (presigned URL stays the same — we only care about the metadata).
  useEffect(() => {
    if (!playback) return;
    const hasTranscript = playback.transcript && playback.transcript.length > 0;
    const hasSummary = !!playback.summary;
    if (hasTranscript && hasSummary) return; // nothing left to wait for
    const t = setInterval(async () => {
      try {
        const p = await api<Playback>(
          `/courses/${params.courseId}/sessions/${params.sessionId}/playback`,
        );
        // Only replace metadata — keep the original video URL to avoid
        // tearing down the <video> element mid-playback.
        setPlayback((prev) =>
          prev
            ? {
                ...prev,
                transcript: p.transcript,
                summary: p.summary,
                chapters: p.chapters,
                chaptersSource: p.chaptersSource,
                thumbnailUrl: prev.thumbnailUrl ?? p.thumbnailUrl,
              }
            : p,
        );
      } catch {}
    }, 8000);
    // Give up after 10 minutes — LLM should be done long before then.
    const timeout = setTimeout(() => clearInterval(t), 10 * 60 * 1000);
    return () => {
      clearInterval(t);
      clearTimeout(timeout);
    };
  }, [playback, params.courseId, params.sessionId]);

  // Load archived questions for this session
  useEffect(() => {
    api<ArchivedQuestion[]>(
      `/courses/${params.courseId}/sessions/${params.sessionId}/questions`,
    )
      .then(setArchivedQs)
      .catch(() => {});
  }, [params.courseId, params.sessionId]);

  async function askAsyncQuestion() {
    if (!newQ.trim()) return;
    try {
      await api(`/courses/${params.courseId}/sessions/${params.sessionId}/questions`, {
        method: 'POST',
        body: { text: newQ },
      });
      setNewQ('');
      toast.success('Question submitted — the teacher will see it');
      const list = await api<ArchivedQuestion[]>(
        `/courses/${params.courseId}/sessions/${params.sessionId}/questions`,
      );
      setArchivedQs(list);
    } catch (e: any) {
      toast.error(e?.body?.error ?? 'failed');
    }
  }

  // Seek to saved position once the video has metadata
  useEffect(() => {
    const v = videoRef.current;
    if (!v || startedAtPos === null || startedAtPos <= 0 || !playback) return;
    const onLoaded = () => {
      if (v.currentTime < 1 && startedAtPos < (v.duration || Infinity) - 5) {
        v.currentTime = startedAtPos;
      }
    };
    v.addEventListener('loadedmetadata', onLoaded);
    return () => v.removeEventListener('loadedmetadata', onLoaded);
  }, [playback, startedAtPos]);

  // Persist progress every 10s + on pause/ended
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !playback) return;
    const save = async (completed = false) => {
      const t = Math.round(v.currentTime);
      if (!completed && Math.abs(t - lastSavedRef.current) < 10) return;
      lastSavedRef.current = t;
      try {
        await api('/progress', {
          method: 'PUT',
          body: { sessionId: params.sessionId, positionSec: t, completed },
        });
      } catch {}
    };
    const onTime = () => {
      const t = v.currentTime;
      const chapters = playback.chapters ?? [];
      let ci = 0;
      for (let i = 0; i < chapters.length; i++) if (t >= chapters[i].timeSec) ci = i;
      setActiveChapter(ci);
      const tr = playback.transcript ?? [];
      let ti = 0;
      for (let i = 0; i < tr.length; i++) if (t >= tr[i].startSec) ti = i;
      setActiveTranscript(ti);
      save(false);
    };
    const onPause = () => save(false);
    const onEnded = () => save(true);
    v.addEventListener('timeupdate', onTime);
    v.addEventListener('pause', onPause);
    v.addEventListener('ended', onEnded);
    return () => {
      v.removeEventListener('timeupdate', onTime);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('ended', onEnded);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playback]);

  async function retry() {
    if (!session?.recording?.id) return;
    try {
      await api(
        `/courses/${params.courseId}/sessions/${params.sessionId}/recordings/${session.recording.id}/retry`,
        { method: 'POST' },
      );
      toast.info('Retrying processing…');
      setPlayback(null);
      const s = await api<Session>(
        `/courses/${params.courseId}/sessions/${params.sessionId}`,
      );
      setSession(s);
    } catch (e: any) {
      toast.error(e?.body?.error ?? 'retry failed');
    }
  }

  async function resetRecording() {
    if (!session?.recording?.id) return;
    if (
      !confirm(
        'Reset this recording? The stuck recording will be wiped and the session reverts to SCHEDULED so you can start fresh.',
      )
    )
      return;
    try {
      await api(
        `/courses/${params.courseId}/sessions/${params.sessionId}/recordings/${session.recording.id}/reset`,
        { method: 'POST' },
      );
      toast.success('Recording reset — you can start a new one');
      setPlayback(null);
      const s = await api<Session>(
        `/courses/${params.courseId}/sessions/${params.sessionId}`,
      );
      setSession(s);
    } catch (e: any) {
      toast.error(e?.body?.error ?? 'reset failed');
    }
  }

  // Detect a recording that's been "processing" for an unreasonably long time.
  // A normal 1-minute recording transcodes in < 1 minute; if it's been stuck
  // for more than 5 minutes something went wrong — offer a reset.
  const stuckThresholdMs = 5 * 60 * 1000;
  const isStuck =
    session?.recording &&
    (session.recording.status === RecordingStatus.PROCESSING ||
      session.recording.status === RecordingStatus.UPLOADING) &&
    Date.now() - new Date((session.recording as any).updatedAt ?? Date.now()).getTime() >
      stuckThresholdMs;

  function seekTo(sec: number) {
    if (!videoRef.current) return;
    videoRef.current.currentTime = sec;
    videoRef.current.play().catch(() => {});
  }

  if (loading)
    return (
      <div className="p-6 flex flex-col gap-4 max-w-6xl">
        <Skeleton className="h-8 w-60" />
        <div className="grid grid-cols-[1.6fr_1fr] gap-5">
          <Skeleton className="aspect-video" />
          <Skeleton className="h-40" />
        </div>
      </div>
    );
  if (!session) return null;

  // Live takeover: if session is currently LIVE and this is a student, show
  // the realtime classroom instead of the playback VOD view. Teachers get
  // a "Continue teaching" button that brings them to /record.
  if (session.status === SessionStatus.LIVE && myRole === CourseRole.STUDENT) {
    return (
      <div className="p-6 flex flex-col gap-4 max-w-[1400px]">
        <div className="flex items-center justify-between">
          <div>
            <div className="font-mono text-[11px] text-ink-mute">
              <Link href={`/courses/${params.courseId}`} className="hover:underline">
                ← back to course
              </Link>
            </div>
            <h1 className="text-xl font-bold mt-1">{session.title}</h1>
          </div>
          <StatusPill kind="recording" />
        </div>
        <StudentLive
          courseId={params.courseId}
          sessionId={params.sessionId}
          sessionTitle={session.title}
        />
      </div>
    );
  }

  const recStatus = session.recording?.status;
  const ready = recStatus === RecordingStatus.READY && playback;
  const chapters = playback?.chapters ?? [];

  if (focusMode && ready) {
    return (
      <div className="fixed inset-0 z-50 bg-black flex flex-col">
        <div className="flex items-center gap-3 px-5 py-3 text-white border-b border-zinc-800">
          <button
            onClick={() => setFocusMode(false)}
            className="h-8 px-3 rounded border border-zinc-600 text-sm hover:bg-white/5"
          >
            ← Exit focus
          </button>
          <div className="min-w-0">
            <div className="text-[10px] font-mono text-zinc-500 uppercase">Session</div>
            <div className="font-bold text-sm truncate">{session.title}</div>
          </div>
        </div>
        <div className="flex-1 flex items-center justify-center p-8">
          <video
            ref={videoRef}
            src={playback!.url}
            poster={playback!.thumbnailUrl ?? undefined}
            controls
            autoPlay
            className="w-full h-full max-w-full max-h-full object-contain"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 flex flex-col gap-4 max-w-6xl">
      <div className="flex items-center justify-between">
        <div>
          <div className="font-mono text-[11px] text-ink-mute">
            <Link href={`/courses/${params.courseId}`} className="hover:underline">
              ← back to course
            </Link>
          </div>
          <h1 className="text-xl font-bold mt-1">{session.title}</h1>
        </div>
        <div className="flex gap-2 items-center">
          <StatusPill kind={sessionStatusPillKind(session.status, recStatus)} />
          {ready && (
            <Button variant="ghost" size="sm" onClick={() => setFocusMode(true)}>
              ⛶ Focus
            </Button>
          )}
          {myRole === CourseRole.TEACHER && (recStatus === RecordingStatus.FAILED || recStatus === RecordingStatus.PROCESSING) && (
            <Button variant={recStatus === RecordingStatus.FAILED ? 'danger' : 'ghost'} onClick={retry}>
              {recStatus === RecordingStatus.FAILED ? 'Retry processing' : 'Nudge worker'}
            </Button>
          )}
          {myRole === CourseRole.TEACHER && isStuck && (
            <Button variant="danger" onClick={resetRecording}>
              ✕ Reset (stuck)
            </Button>
          )}
          {myRole === CourseRole.TEACHER && !ready && recStatus !== RecordingStatus.PROCESSING && recStatus !== RecordingStatus.FAILED && (
            <Link href={`/courses/${params.courseId}/sessions/${params.sessionId}/record`}>
              <Button variant="primary">
                {session.status === SessionStatus.LIVE ? 'Continue teaching' : 'Start recording'}
              </Button>
            </Link>
          )}
        </div>
      </div>

      <div className="grid grid-cols-[1.6fr_1fr] gap-5">
        <div className="flex flex-col gap-3 min-w-0">
          <div className="aspect-video bg-black border border-ink rounded overflow-hidden relative">
            {ready ? (
              <video
                ref={videoRef}
                src={playback!.url}
                poster={playback!.thumbnailUrl ?? undefined}
                controls
                className="w-full h-full"
              />
            ) : (
              <NotReadyOverlay status={recStatus ?? RecordingStatus.PENDING} errorMsg={session.recording?.errorMessage} />
            )}
          </div>

          {playback?.summary && (
            <div className="border border-accent bg-accent-soft/40 rounded p-3.5">
              <div className="text-[11px] font-semibold text-accent mb-1 flex items-center gap-2">
                SUMMARY
                <span className="text-[9px] font-normal text-ink-mute">
                  AI-generated
                </span>
              </div>
              <div className="text-sm leading-relaxed">{playback.summary}</div>
            </div>
          )}

          <div className="border border-ink rounded p-3.5">
            <div className="text-[11px] font-semibold text-ink-soft mb-2 flex items-center gap-2">
              <span>CHAPTERS {chapters.length > 0 && `· ${chapters.length}`}</span>
              {playback?.chaptersSource === 'auto' && (
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-warn-soft text-warn border border-warn/40">
                  AI-generated
                </span>
              )}
            </div>
            {!ready ? (
              <div className="text-xs text-ink-mute">Available once the recording is ready.</div>
            ) : chapters.length === 0 ? (
              <div className="text-xs text-ink-mute">No chapters were marked for this recording.</div>
            ) : (
              <ol className="text-sm">
                {chapters.map((c, i) => (
                  <li
                    key={i}
                    onClick={() => seekTo(c.timeSec)}
                    className={[
                      'flex gap-3 py-1.5 px-2 -mx-2 rounded cursor-pointer hover:bg-paper-alt items-center border-b last:border-b-0 border-dashed border-ink/10',
                      i === activeChapter ? 'bg-accent-soft text-accent font-bold' : '',
                    ].join(' ')}
                  >
                    <span className="font-mono text-xs w-12 text-ink-mute">
                      {fmtDuration(c.timeSec)}
                    </span>
                    <span className="flex-1">{c.label}</span>
                    {i === activeChapter && <span>▶</span>}
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-3 min-w-0">
          <div className="border border-ink rounded p-3.5">
            <div className="text-[11px] font-semibold text-ink-soft">DESCRIPTION</div>
            <div className="text-sm mt-1">{session.description ?? '—'}</div>
          </div>

          <div className="border border-ink rounded overflow-hidden">
            <div className="flex gap-4 border-b border-ink px-3 bg-paper-alt">
              {(['transcript', 'notes'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={[
                    'py-2 -mb-px font-semibold capitalize text-sm',
                    tab === t
                      ? 'border-b-2 border-accent text-accent'
                      : 'text-ink-soft hover:text-ink',
                  ].join(' ')}
                >
                  {t}
                </button>
              ))}
            </div>
            {tab === 'transcript' && (
              <TranscriptPane
                ready={!!ready}
                transcript={playback?.transcript ?? []}
                activeIndex={activeTranscript}
                search={transcriptSearch}
                setSearch={setTranscriptSearch}
                onSeek={seekTo}
              />
            )}
            {tab === 'notes' && (
              <div className="p-3 text-xs text-ink-mute">
                Private notes per user are a Phase 2 feature.
              </div>
            )}
          </div>

          <div className="border border-ink rounded p-3.5">
            <div className="text-[11px] font-semibold text-ink-soft">DETAILS</div>
            <ul className="text-sm mt-2 space-y-1">
              <li>
                Scheduled:{' '}
                <b>{session.scheduledAt ? new Date(session.scheduledAt).toLocaleString() : '—'}</b>
              </li>
              <li>
                Duration: <b>{fmtDuration(session.recording?.durationSec)}</b>
              </li>
              <li>
                Recording: <b>{recStatus ?? 'none'}</b>
              </li>
            </ul>
          </div>

          <div className="border border-ink rounded p-3.5">
            <div className="text-[11px] font-semibold text-ink-soft flex justify-between items-center">
              <span>
                QUESTIONS {archivedQs.length > 0 && `· ${archivedQs.length}`}
              </span>
            </div>
            {myRole === CourseRole.STUDENT && (
              <form
                className="mt-2 flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  askAsyncQuestion();
                }}
              >
                <input
                  value={newQ}
                  onChange={(e) => setNewQ(e.target.value)}
                  placeholder="Ask even after the session ends…"
                  className="flex-1 h-9 px-2 border border-ink rounded text-sm"
                />
                <Button type="submit" variant="primary" size="sm" disabled={!newQ.trim()}>
                  Ask
                </Button>
              </form>
            )}
            <div className="mt-3 flex flex-col gap-2 max-h-80 overflow-auto">
              {archivedQs.length === 0 ? (
                <div className="text-xs text-ink-mute">No questions yet.</div>
              ) : (
                archivedQs.map((q) => (
                  <div
                    key={q.id}
                    className="border border-ink/30 rounded p-2 flex flex-col gap-1 bg-paper"
                  >
                    <div className="flex justify-between items-baseline gap-2">
                      <span className="font-bold text-xs">{q.askedByName}</span>
                      <span className="font-mono text-[10px] text-ink-mute">
                        {new Date(q.createdAt).toLocaleString()}
                      </span>
                    </div>
                    <div className="text-sm">{q.text}</div>
                    {q.answerText && (
                      <div className="mt-1 border-l-2 border-accent pl-2 text-sm bg-accent-soft/30 rounded py-1">
                        <div className="text-[10px] text-accent font-bold">
                          ANSWERED by {q.answeredByName}
                        </div>
                        {q.answerText}
                      </div>
                    )}
                    {!q.answeredAt && (
                      <span className="text-[10px] font-bold text-warn">unanswered</span>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function TranscriptPane({
  ready,
  transcript,
  activeIndex,
  search,
  setSearch,
  onSeek,
}: {
  ready: boolean;
  transcript: TranscriptSegment[];
  activeIndex: number;
  search: string;
  setSearch: (s: string) => void;
  onSeek: (t: number) => void;
}) {
  const query = search.trim().toLowerCase();
  const matches =
    query.length > 0
      ? transcript
          .map((s, i) => ({ s, i }))
          .filter(({ s }) => s.text.toLowerCase().includes(query))
      : null;

  if (!ready) {
    return (
      <div className="p-3 text-xs text-ink-mute">
        Transcript is generated automatically after the recording processes. If no Whisper
        provider is configured on the server, no transcript is produced.
      </div>
    );
  }

  if (transcript.length === 0) {
    return (
      <div className="p-3 flex items-center gap-2 text-xs text-ink-mute">
        <div
          className="w-3 h-3 rounded-full border-2 border-warn border-t-transparent animate-spin-slow"
          aria-hidden
        />
        <span>
          Transcript is still generating in the background — this page will update
          automatically when it's ready (usually 30 s – 2 min after the recording
          becomes available).
        </span>
      </div>
    );
  }

  return (
    <>
      <div className="px-2 pt-2">
        <div className="relative">
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-mute text-sm">
            ⌕
          </span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search spoken text…"
            className="h-8 pl-7 pr-2 w-full border border-ink rounded text-sm"
          />
        </div>
        {matches && (
          <div className="text-[10px] font-mono text-ink-mute mt-1">
            {matches.length} match{matches.length === 1 ? '' : 'es'}
          </div>
        )}
      </div>
      <div className="max-h-80 overflow-auto p-2.5 flex flex-col gap-1.5 text-sm">
        {(matches ?? transcript.map((s, i) => ({ s, i }))).map(({ s, i }) => {
          const isActive = i === activeIndex && !query;
          return (
            <button
              key={i}
              onClick={() => onSeek(s.startSec)}
              className={[
                'flex gap-2.5 text-left hover:bg-paper-alt rounded px-1.5 py-1',
                isActive ? 'bg-accent-soft' : '',
              ].join(' ')}
            >
              <span className="font-mono text-[11px] text-ink-mute w-12 flex-shrink-0 pt-0.5">
                {fmtDuration(s.startSec)}
              </span>
              <span className={isActive ? 'text-accent font-semibold' : ''}>
                {query ? <HighlightedText text={s.text} term={query} /> : s.text}
              </span>
            </button>
          );
        })}
        {matches && matches.length === 0 && (
          <div className="text-xs text-ink-mute text-center py-4">
            No match for "{search}"
          </div>
        )}
      </div>
    </>
  );
}

function HighlightedText({ text, term }: { text: string; term: string }) {
  if (!term) return <>{text}</>;
  const lower = text.toLowerCase();
  const parts: React.ReactNode[] = [];
  let i = 0;
  while (i < text.length) {
    const hit = lower.indexOf(term, i);
    if (hit === -1) {
      parts.push(text.slice(i));
      break;
    }
    if (hit > i) parts.push(text.slice(i, hit));
    parts.push(
      <mark key={hit} className="bg-warn-soft text-warn px-0.5 rounded">
        {text.slice(hit, hit + term.length)}
      </mark>,
    );
    i = hit + term.length;
  }
  return <>{parts}</>;
}

function NotReadyOverlay({
  status,
  errorMsg,
}: {
  status: string;
  errorMsg?: string | null;
}) {
  if (status === RecordingStatus.PROCESSING || status === RecordingStatus.UPLOADING) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center text-white gap-3">
        <div
          className="w-12 h-12 rounded-full border-[3px] border-warn border-t-transparent animate-spin-slow"
          aria-hidden
        />
        <div className="font-bold">Processing recording…</div>
        <div className="text-xs text-zinc-400">usually 30 s – 5 min · this page auto-refreshes</div>
      </div>
    );
  }
  if (status === RecordingStatus.FAILED) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center text-white gap-2 px-8 text-center">
        <div className="text-live font-bold text-lg">Recording failed</div>
        <div className="text-xs text-zinc-400">{errorMsg ?? 'The encoder returned an error.'}</div>
      </div>
    );
  }
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center text-white gap-2">
      <div className="font-bold">No recording yet</div>
      <div className="text-xs text-zinc-400">The session hasn't been recorded.</div>
    </div>
  );
}
