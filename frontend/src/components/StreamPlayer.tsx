import { useEffect, useRef, useState } from 'react';
import { Play, Loader2, AlertCircle } from 'lucide-react';
import cameraPlaceholder from '../assets/camera-placeholder.svg';

/**
 * Plays an S300 camera stream inline.
 *   - recorded MP4 (…/*.mp4)         → native <video> (range requests, seekable)
 *   - realtime HTTP-FLV (…/*.flv)    → mpegts.js over MSE (live, low latency)
 * Live FLV is lazy: it only connects when the user clicks Play, so opening an
 * inspection with 6 cameras doesn't fire 6 live connections at once.
 */
export default function StreamPlayer({ url, kind, label }: {
  url: string;
  kind: 'record' | 'realtime' | string;
  label?: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<{ destroy: () => void } | null>(null);
  const isFlv = kind === 'realtime' || /\.flv(\?|$)/i.test(url);
  const [playing, setPlaying] = useState(!isFlv); // MP4 loads immediately; FLV waits for Play
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isFlv || !playing) return;
    let cancelled = false;
    setLoading(true);
    setError('');

    (async () => {
      try {
        const mod = await import('mpegts.js');
        const mpegts = mod.default;
        if (cancelled) return;
        if (!mpegts.isSupported()) { setError('MSE not supported in this browser'); setLoading(false); return; }
        const video = videoRef.current;
        if (!video) return;
        const player = mpegts.createPlayer(
          { type: 'flv', isLive: true, url },
          { enableWorker: true, liveBufferLatencyChasing: true, lazyLoad: false },
        );
        playerRef.current = player;
        player.on(mpegts.Events.ERROR, (_t: string, d: string) => setError(`stream error: ${d}`));
        player.attachMediaElement(video);
        player.load();
        await video.play().catch(() => undefined);
        if (!cancelled) setLoading(false);
      } catch (e) {
        if (!cancelled) { setError((e as Error).message); setLoading(false); }
      }
    })();

    return () => {
      cancelled = true;
      if (playerRef.current) { try { playerRef.current.destroy(); } catch { /* ignore */ } playerRef.current = null; }
    };
  }, [isFlv, playing, url]);

  return (
    <div className="bg-black aspect-video rounded relative overflow-hidden group">
      {/* MP4 plays natively; FLV attaches to this same element via mpegts.js */}
      {(playing || !isFlv) ? (
        <video
          ref={videoRef}
          className="w-full h-full object-contain bg-black"
          controls={!isFlv}
          muted
          playsInline
          poster={cameraPlaceholder}
          src={isFlv ? undefined : url}
        />
      ) : (
        <button onClick={() => setPlaying(true)}
          className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-white/80 hover:text-white bg-black/40 hover:bg-black/20 transition">
          <Play className="w-8 h-8" />
          <span className="text-[10px]">LIVE</span>
        </button>
      )}

      {label && (
        <div className="absolute top-1 left-1 text-[10px] font-mono text-white/80 bg-black/60 px-1.5 py-0.5 rounded z-10">{label}</div>
      )}
      {isFlv && playing && (
        <div className="absolute top-1 right-1 text-[9px] font-medium text-white bg-green-600/80 px-1.5 py-0.5 rounded flex items-center gap-1 z-10">
          <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" /> LIVE
        </div>
      )}
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center text-white/70">
          <Loader2 className="w-6 h-6 animate-spin" />
        </div>
      )}
      {error && (
        <div className="absolute bottom-0 inset-x-0 bg-danger/80 text-white text-[9px] px-1.5 py-1 flex items-center gap-1">
          <AlertCircle className="w-3 h-3 shrink-0" /> <span className="truncate">{error}</span>
        </div>
      )}
    </div>
  );
}
