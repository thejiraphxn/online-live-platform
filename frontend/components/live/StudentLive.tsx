'use client';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useLiveRoom } from './useLiveRoom';
import { LivePanel } from './LivePanel';
import { MeetingGrid } from './MeetingGrid';
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

  const myself = state.participants.find((p) => p.socketId === state.mySocketId);
  const teacher = state.participants.find((p) => p.role === CourseRole.TEACHER);
  // Decide what fallback message to show if the main speaker tile is empty.
  const emptyMainState = !state.connected
    ? 'Connecting to classroom…'
    : state.error
      ? `Connection error: ${state.error}`
      : teacher
        ? "Waiting for the teacher's video to arrive…"
        : 'Waiting for the teacher to join the room…';

  // Click-to-unmute overlay — required because most browsers block audio
  // autoplay until the user has interacted with the page.
  const muteOverlay =
    muted && teacher ? (
      <button
        onClick={() => setMuted(false)}
        className="absolute inset-0 bg-black/40 flex flex-col items-center justify-center gap-2 text-white hover:bg-black/60 transition-colors rounded-lg"
      >
        <div className="text-3xl">🔇</div>
        <div className="font-bold text-sm">Click to unmute</div>
        <div className="text-[11px] text-zinc-300">
          Browsers block autoplay with sound until you interact
        </div>
      </button>
    ) : null;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1.5fr_1fr] gap-4">
      <div className="flex flex-col gap-3">
        <MeetingGrid
          state={state}
          selfRole={CourseRole.STUDENT}
          selfName={myself?.name ?? 'You'}
          selfStream={myStream}
          selfMicOn={micOn && !!myStream}
          selfCamOn={camOn && !!myStream}
          showMainSpeaker
          audioMuted={muted}
          mainOverlay={muteOverlay}
          emptyMainState={emptyMainState}
        />

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
          {teacher && muted && (
            <Button variant="primary" onClick={() => setMuted(false)}>
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
