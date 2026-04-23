'use client';
import { useEffect, useRef, useState } from 'react';

type Check = { label: string; state: 'ok' | 'warn' | 'unknown'; detail?: string };

export function PreflightCheck({
  onReady,
}: {
  // Hand the live mic stream to the caller so the recorder can reuse it and
  // we don't double-prompt the user for microphone permission.
  onReady: (micStream: MediaStream | null) => void;
}) {
  const [mic, setMic] = useState<Check>({ label: 'Microphone', state: 'unknown' });
  const [display, setDisplay] = useState<Check>({ label: 'Screen capture', state: 'unknown' });
  const [mediaRec, setMediaRec] = useState<Check>({
    label: 'MediaRecorder / WebM support',
    state: 'unknown',
  });
  const [micLevel, setMicLevel] = useState(0);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    const hasDisplay = !!navigator.mediaDevices?.getDisplayMedia;
    setDisplay({
      label: 'Screen capture',
      state: hasDisplay ? 'ok' : 'warn',
      detail: hasDisplay ? 'supported' : 'browser does not support getDisplayMedia',
    });
    const hasMR =
      typeof MediaRecorder !== 'undefined' &&
      MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus');
    setMediaRec({
      label: 'MediaRecorder / WebM support',
      state: hasMR ? 'ok' : 'warn',
      detail: hasMR ? 'vp8 + opus' : 'webm/vp8/opus not supported — try Chrome',
    });

    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const label = stream.getAudioTracks()[0]?.label ?? 'default mic';
        setMic({ label: 'Microphone', state: 'ok', detail: label });

        // VU meter
        const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
        audioCtxRef.current = ctx;
        const src = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        src.connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);
        const tick = () => {
          analyser.getByteTimeDomainData(data);
          let sum = 0;
          for (const v of data) sum += (v - 128) ** 2;
          const rms = Math.sqrt(sum / data.length) / 128;
          setMicLevel(Math.min(1, rms * 3));
          rafRef.current = requestAnimationFrame(tick);
        };
        tick();
      } catch (e: any) {
        setMic({
          label: 'Microphone',
          state: 'warn',
          detail: e?.message ?? 'permission denied',
        });
      }
    })();

    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      // Close the VU-meter AudioContext — without this it can hold a
      // reference to the mic stream and keep the indicator on even after
      // the tracks have been stopped.
      if (audioCtxRef.current) {
        audioCtxRef.current.close().catch(() => {});
        audioCtxRef.current = null;
      }
      // NOTE: don't stop the mic tracks here — the Recorder will inherit them.
      // Tracks get stopped when Recorder.stop() runs.
    };
  }, []);

  const checks = [mic, display, mediaRec];
  const allOk = checks.every((c) => c.state === 'ok');

  return (
    <div className="border border-ink rounded p-4">
      <div className="text-[11px] font-semibold text-ink-soft mb-2">PRE-FLIGHT CHECK</div>
      <ul className="flex flex-col gap-1.5">
        {checks.map((c) => (
          <li key={c.label} className="flex items-center gap-2.5 text-sm">
            <span
              className={[
                'w-7 h-7 rounded-full flex items-center justify-center font-bold text-base leading-none',
                c.state === 'ok'
                  ? 'bg-ok-soft text-ok border border-ok'
                  : c.state === 'warn'
                    ? 'bg-warn-soft text-warn border border-warn'
                    : 'bg-paper-alt text-ink-mute border border-ink-mute/40',
              ].join(' ')}
            >
              {c.state === 'ok' ? '✓' : c.state === 'warn' ? '!' : '…'}
            </span>
            <span className="font-semibold">{c.label}</span>
            {c.detail && (
              <span className="text-xs text-ink-soft font-mono truncate">— {c.detail}</span>
            )}
          </li>
        ))}
      </ul>

      <div className="mt-4">
        <div className="text-[11px] text-ink-soft font-semibold mb-1">MIC LEVEL</div>
        <div className="h-2 bg-paper-alt border border-ink-mute/40 rounded overflow-hidden">
          <div
            className={
              micLevel > 0.75 ? 'h-full bg-live' : 'h-full bg-ok transition-[width]'
            }
            style={{ width: `${Math.round(micLevel * 100)}%` }}
          />
        </div>
        <div className="text-[10px] font-mono text-ink-mute mt-1">
          {mic.state === 'ok' ? 'Say something to verify you can be heard.' : '—'}
        </div>
      </div>

      <div className="mt-4 flex justify-end">
        <button
          onClick={() => {
            // Stop the VU-meter loop but keep the mic tracks alive — hand them
            // off to the recorder so the user isn't re-prompted.
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
            onReady(streamRef.current);
          }}
          disabled={!allOk}
          className="h-10 px-4 rounded border border-live bg-live text-white font-bold disabled:opacity-50 disabled:cursor-not-allowed"
        >
          ● Start recording
        </button>
      </div>
    </div>
  );
}
