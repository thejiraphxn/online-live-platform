'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Recorder, type RecorderStatus } from '@/components/record/Recorder';
import { PreflightCheck } from '@/components/record/PreflightCheck';
import { Button } from '@/components/ui/Button';
import { StatusPill } from '@/components/ui/StatusPill';
import { useToast } from '@/components/ui/Toast';
import { useLiveRoom } from '@/components/live/useLiveRoom';
import { LivePanel } from '@/components/live/LivePanel';
import { RemoteVideo } from '@/components/live/RemoteVideo';
import { CourseRole, RecordingStatus } from '@/lib/enums';

type Session = {
  id: string;
  courseId: string;
  title: string;
  description: string | null;
  status: string;
  scheduledAt: string | null;
  recording: null | { id: string; status: string; errorMessage?: string | null };
};

export default function RecordPage({ params }: { params: { courseId: string; sessionId: string } }) {
  const [session, setSession] = useState<Session | null>(null);
  const [processingStatus, setProcessingStatus] = useState<string | null>(null);
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [passedPreflight, setPassedPreflight] = useState(false);
  const [preflightMicStream, setPreflightMicStream] = useState<MediaStream | null>(null);
  const [recorderStatus, setRecorderStatus] = useState<RecorderStatus>('idle');
  const toast = useToast();

  const isLive = recorderStatus === 'recording';
  const [liveState, liveActions] = useLiveRoom(params.sessionId, true);

  async function reload() {
    try {
      const s = await api<Session>(
        `/courses/${params.courseId}/sessions/${params.sessionId}`,
      );
      setSession(s);
      if (s.recording?.status === RecordingStatus.FAILED) {
        setProcessingStatus(RecordingStatus.FAILED);
        setRecordingId(s.recording.id);
      }
    } catch (e: any) {
      toast.error(e?.body?.error ?? 'failed to load');
    }
  }
  useEffect(() => {
    reload();
  }, [params.courseId, params.sessionId]);

  // Load past questions once
  useEffect(() => {
    api<any[]>(`/courses/${params.courseId}/sessions/${params.sessionId}/questions`)
      .then((past) => {
        // merge with state questions (avoid duplicates)
        if (past.length > 0) {
          // direct mutation through setQuestions isn't exposed; rely on real-time from socket instead
          // however, we can seed by sending to the socket state — simplest: ignore duplicates later
        }
      })
      .catch(() => {});
  }, [params.courseId, params.sessionId]);

  useEffect(() => {
    if (!processingStatus) return;
    if (processingStatus === RecordingStatus.READY || processingStatus === RecordingStatus.FAILED) return;
    const id = recordingId ?? session?.recording?.id;
    if (!id) return;
    const t = setInterval(async () => {
      try {
        const r = await api<{ status: string }>(
          `/courses/${params.courseId}/sessions/${params.sessionId}/recordings/${id}`,
        );
        setProcessingStatus(r.status);
        if (r.status === RecordingStatus.READY) toast.success('Recording is ready 🎉');
        if (r.status === RecordingStatus.FAILED) toast.error('Processing failed');
      } catch {}
    }, 4000);
    return () => clearInterval(t);
  }, [processingStatus, recordingId, session?.recording?.id, params.courseId, params.sessionId, toast]);

  async function retry() {
    const id = recordingId ?? session?.recording?.id;
    if (!id) return;
    try {
      await api(`/courses/${params.courseId}/sessions/${params.sessionId}/recordings/${id}/retry`, {
        method: 'POST',
      });
      toast.info('Retrying…');
      setProcessingStatus(RecordingStatus.PROCESSING);
    } catch (e: any) {
      toast.error(e?.body?.error ?? 'retry failed');
    }
  }

  if (!session) return null;
  const rec = session.recording;
  // If the previous attempt FAILED we treat it as "no recording yet" — the
  // init endpoint already resets the row, so the teacher can start fresh.
  const canStartFresh =
    !rec ||
    rec.status === RecordingStatus.PENDING ||
    rec.status === RecordingStatus.UPLOADING ||
    rec.status === RecordingStatus.FAILED;
  const showRecorder = passedPreflight && canStartFresh;
  const showProcessing =
    processingStatus ||
    rec?.status === RecordingStatus.PROCESSING ||
    rec?.status === RecordingStatus.READY;
  const showPreviousFailed = rec?.status === RecordingStatus.FAILED && !processingStatus;

  // Student remote videos (those accepted to publish) — only render publishers
  const publishingStudents = liveState.participants.filter(
    (p) => p.role === CourseRole.STUDENT && p.isPublishing && p.socketId !== liveState.mySocketId,
  );

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
          <div className="text-xs text-ink-soft flex gap-2 items-center">
            {isLive && <span className="text-live font-bold">● LIVE to students</span>}
            <span>·</span>
            <span>
              {liveState.participants.filter((p) => p.role === CourseRole.STUDENT).length} student
              {liveState.participants.filter((p) => p.role === CourseRole.STUDENT).length === 1 ? '' : 's'}{' '}
              in room
            </span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-[1.3fr_1fr] gap-4">
        <div className="flex flex-col gap-3">
          {showPreviousFailed && (
            <div className="border border-live bg-live-soft rounded p-3 text-sm">
              <div className="font-bold text-live">Previous attempt failed</div>
              <div className="text-ink-soft text-xs mt-1">
                {rec?.errorMessage ?? 'The earlier recording did not complete successfully.'}
                {' '}You can start a new recording below.
              </div>
            </div>
          )}

          {!passedPreflight && !showProcessing && (
            <PreflightCheck
              onReady={(micStream) => {
                setPreflightMicStream(micStream);
                setPassedPreflight(true);
              }}
            />
          )}

          {showRecorder && (
            <Recorder
              courseId={params.courseId}
              sessionId={params.sessionId}
              autoStart
              existingMicStream={preflightMicStream}
              onRecordingIdChange={setRecordingId}
              onStatus={setRecorderStatus}
              onStream={(stream) => liveActions.publish(stream)}
              onComplete={() => {
                setProcessingStatus(RecordingStatus.PROCESSING);
                reload();
              }}
            />
          )}

          {publishingStudents.length > 0 && (
            <div className="border border-ink rounded p-3">
              <div className="text-[11px] font-semibold text-ink-soft mb-2">
                STUDENT CAM/MIC ({publishingStudents.length})
              </div>
              <div className="grid grid-cols-2 gap-2">
                {publishingStudents.map((p) => (
                  <RemoteVideo
                    key={p.socketId}
                    stream={liveState.remoteStreams.get(p.socketId) ?? null}
                    label={p.name}
                    className="aspect-video"
                  />
                ))}
              </div>
            </div>
          )}

          {showProcessing && (
            <div className="border border-ink rounded p-4 bg-paper flex gap-4 items-center">
              {processingStatus !== RecordingStatus.READY && processingStatus !== RecordingStatus.FAILED && (
                <div
                  className="w-10 h-10 rounded-full border-[3px] border-warn border-t-transparent animate-spin-slow flex-shrink-0"
                  aria-hidden
                />
              )}
              <div className="flex-1">
                <div className="flex gap-2 items-center">
                  <span className="font-bold">
                    {processingStatus === RecordingStatus.READY
                      ? 'Recording ready 🎉'
                      : processingStatus === RecordingStatus.FAILED
                        ? 'Recording failed'
                        : 'Processing recording'}
                  </span>
                  <StatusPill
                    kind={
                      processingStatus === RecordingStatus.READY
                        ? 'ready'
                        : processingStatus === RecordingStatus.FAILED
                          ? 'failed'
                          : 'processing'
                    }
                  />
                </div>
                <div className="text-xs text-ink-soft">
                  {processingStatus === RecordingStatus.READY
                    ? 'Video is live. Transcript + summary generate in background.'
                    : processingStatus === RecordingStatus.FAILED
                      ? rec?.errorMessage ?? 'Encoder failed.'
                      : "Transcoding video (30 s – 2 min). Transcript runs after."}
                </div>
              </div>
              {processingStatus === RecordingStatus.READY && (
                <Link href={`/courses/${params.courseId}/sessions/${params.sessionId}`}>
                  <Button variant="primary">Open playback →</Button>
                </Link>
              )}
              {processingStatus === RecordingStatus.FAILED && (
                <Button variant="danger" onClick={retry}>
                  Retry
                </Button>
              )}
            </div>
          )}
        </div>

        <div>
          <LivePanel
            state={liveState}
            actions={liveActions}
            myRole="TEACHER"
            courseId={params.courseId}
            sessionId={params.sessionId}
          />
        </div>
      </div>
    </div>
  );
}
