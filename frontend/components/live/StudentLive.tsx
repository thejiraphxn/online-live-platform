'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useLiveRoom, pickPrimaryStream, pickSecondaryStream } from './useLiveRoom';
import { LivePanel } from './LivePanel';
import { RemoteVideo } from './RemoteVideo';
import { useToast } from '@/components/ui/Toast';
import { CourseRole } from '@/lib/enums';

export function StudentLive({
  courseId,
  sessionId,
  sessionTitle,
}: {
  courseId: string;
  sessionId: string;
  sessionTitle: string;
}) {
  const [state, actions] = useLiveRoom(sessionId, true);
  const toast = useToast();
  const [myStream, setMyStream] = useState<MediaStream | null>(null);
  const [muted, setMuted] = useState(true); // start muted to satisfy autoplay policies
  // Local UI state mirrors track.enabled — we keep our own source of truth
  // so the button updates instantly even before the room:updated echo.
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const mainVideoRef = useRef<HTMLVideoElement | null>(null);
  const pipVideoRef = useRef<HTMLVideoElement | null>(null);

  const teacher = state.participants.find((p) => p.role === CourseRole.TEACHER);
  const teacherStreams = teacher ? state.remoteStreams.get(teacher.socketId) : undefined;
  // Primary = screen+mic (the stream carrying audio). Secondary = webcam
  // (video-only). Teacher may publish only primary, only webcam, or both.
  const teacherStream = pickPrimaryStream(teacherStreams);
  const teacherWebcam = pickSecondaryStream(teacherStreams, teacherStream);

  useEffect(() => {
    if (mainVideoRef.current && mainVideoRef.current.srcObject !== teacherStream) {
      mainVideoRef.current.srcObject = teacherStream;
    }
  }, [teacherStream]);

  useEffect(() => {
    if (pipVideoRef.current && pipVideoRef.current.srcObject !== teacherWebcam) {
      pipVideoRef.current.srcObject = teacherWebcam;
    }
  }, [teacherWebcam]);

  useEffect(() => {
    if (!state.handAcceptedBy) return;
    if (myStream) return;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        setMyStream(stream);
        actions.publish(stream);
        setMicOn(true);
        setCamOn(true);
        actions.setMedia({ isMicOn: true, isCamOn: true });
        toast.success("You're live — mic + camera on");
      } catch (e: any) {
        toast.error(e?.message ?? 'mic/camera permission denied');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.handAcceptedBy]);

  function toggleMic() {
    if (!myStream) return;
    const next = !micOn;
    for (const t of myStream.getAudioTracks()) t.enabled = next;
    setMicOn(next);
    actions.setMedia({ isMicOn: next });
  }

  function toggleCam() {
    if (!myStream) return;
    const next = !camOn;
    for (const t of myStream.getVideoTracks()) t.enabled = next;
    setCamOn(next);
    actions.setMedia({ isCamOn: next });
  }

  function stopPublishing() {
    const goneId = myStream?.id;
    if (myStream) {
      myStream.getTracks().forEach((t) => t.stop());
      setMyStream(null);
    }
    actions.publish(null);
    if (goneId) actions.streamGone(goneId);
    actions.raiseHand(false);
    actions.setMedia({ isMicOn: false, isCamOn: false });
    setMicOn(true);
    setCamOn(true);
    toast.info('Stopped publishing');
  }

  function unmute() {
    setMuted(false);
    mainVideoRef.current?.play().catch(() => {});
  }

  const myself = state.participants.find((p) => p.socketId === state.mySocketId);

  return (
    <div className="grid grid-cols-[1.5fr_1fr] gap-4">
      <div className="flex flex-col gap-3">
        <div className="aspect-video bg-black border border-ink rounded overflow-hidden relative">
          {teacherStream ? (
            <>
              <video
                ref={mainVideoRef}
                autoPlay
                playsInline
                muted={muted}
                className="w-full h-full object-contain"
              />
              {muted && (
                <button
                  onClick={unmute}
                  className="absolute inset-0 bg-black/40 flex flex-col items-center justify-center gap-2 text-white hover:bg-black/60 transition-colors"
                >
                  <div className="text-3xl">🔇</div>
                  <div className="font-bold text-sm">Click to unmute</div>
                  <div className="text-[11px] text-zinc-300">
                    Browsers block autoplay with sound until you interact
                  </div>
                </button>
              )}
            </>
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-white gap-2">
              <div className="animate-blink text-live font-bold text-lg">● LIVE</div>
              <div className="text-xs text-zinc-400">
                {!state.connected
                  ? 'Connecting to classroom…'
                  : state.error
                    ? `Connection error: ${state.error}`
                    : teacher
                      ? "Waiting for the teacher's video to arrive…"
                      : 'Waiting for the teacher to join the room…'}
              </div>
              <div className="text-[10px] text-zinc-500 font-mono mt-2">
                socket: {state.connected ? '✓' : '…'} ·{' '}
                people: {state.participants.length} ·{' '}
                teachers: {state.participants.filter((p) => p.role === CourseRole.TEACHER).length}
              </div>
            </div>
          )}
          {teacherWebcam && (
            <div className="absolute bottom-3 right-3 w-32 md:w-40 aspect-video bg-black rounded border border-white/30 shadow-lg overflow-hidden">
              <video
                ref={pipVideoRef}
                autoPlay
                playsInline
                muted
                className="w-full h-full object-cover"
              />
              <div className="absolute bottom-0 left-0 right-0 bg-black/60 text-white text-[9px] font-mono px-1 py-0.5">
                {teacher?.name ?? 'teacher'}
              </div>
            </div>
          )}
          <div className="absolute top-2 left-2 bg-live text-white text-[10px] font-bold px-2 py-0.5 rounded animate-blink">
            ● LIVE
          </div>
          <div className="absolute top-2 right-2 bg-black/70 text-white text-[11px] px-2 py-0.5 rounded font-mono space-x-2">
            <span>{state.connected ? '🟢' : '🔴'}</span>
            <span>{state.participants.length} in room</span>
            <span>·</span>
            <span>T:{state.participants.filter((p) => p.role === CourseRole.TEACHER).length}</span>
            <span>·</span>
            <span>tracks:{Array.from(state.remoteStreams.values()).reduce((n, s) => n + s.length, 0)}</span>
          </div>
        </div>

        <div className="border border-ink rounded p-3 flex items-center gap-3 flex-wrap">
          <div className="flex-1 min-w-[200px]">
            <div className="font-bold text-sm">{sessionTitle}</div>
            <div className="text-xs text-ink-soft">
              {myself?.hasHandRaised
                ? 'Hand raised — waiting for teacher'
                : myStream
                  ? micOn && camOn
                    ? 'You are live with mic + camera'
                    : camOn
                      ? 'You are live (mic muted)'
                      : micOn
                        ? 'You are live (camera off)'
                        : 'You are live (mic + camera off)'
                  : 'Raise hand to join the conversation'}
            </div>
          </div>
          {teacherStream && muted && (
            <Button variant="primary" onClick={unmute}>
              🔊 Unmute
            </Button>
          )}
          {!myStream && !myself?.hasHandRaised && (
            <Button variant="primary" onClick={() => actions.raiseHand(true)}>
              ✋ Raise hand
            </Button>
          )}
          {myself?.hasHandRaised && !myStream && (
            <Button variant="ghost" onClick={() => actions.raiseHand(false)}>
              Cancel
            </Button>
          )}
          {myStream && (
            <>
              <Button variant={micOn ? 'primary' : 'ghost'} onClick={toggleMic}>
                {micOn ? '🎤 Mic on' : '🔇 Mic off'}
              </Button>
              <Button variant={camOn ? 'primary' : 'ghost'} onClick={toggleCam}>
                {camOn ? '📹 Cam on' : '📷 Cam off'}
              </Button>
              <Button variant="danger" onClick={stopPublishing}>
                ■ Leave stage
              </Button>
            </>
          )}
        </div>

        {myStream && (
          <div className="border border-ink rounded p-3">
            <div className="text-[11px] font-semibold text-ink-soft mb-2">YOUR CAMERA</div>
            <RemoteVideo
              stream={myStream}
              muted
              label="you"
              className="aspect-video max-w-xs"
            />
          </div>
        )}
      </div>

      <div>
        <LivePanel
          state={state}
          actions={actions}
          myRole={CourseRole.STUDENT}
          courseId={courseId}
          sessionId={sessionId}
        />
      </div>
    </div>
  );
}
